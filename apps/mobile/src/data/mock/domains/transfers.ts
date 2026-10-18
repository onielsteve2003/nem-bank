import type { Schema } from '@nem/contracts';
import { add, formatMoney, KYC_TIERS, money, transferFee, type Money } from '@nem/shared';

import { problem } from '../../errors';
import type { BeneficiariesRepo, PayeesRepo, TransfersRepo } from '../../repositories';
import {
  addMinutes,
  api,
  fromApi,
  maskAccount,
  naira,
  newestFirst,
  notFound,
  paginate,
  positive,
} from '../convert';
import { BANKS, bankByCode, externalAccountName, NEM_BANK, nameMatch } from '../directory';
import {
  assertWithinDailyLimit,
  failExternalTransfer,
  settleExternalTransfer,
  spentToday,
  startExternalTransfer,
  transferInternal,
} from '../ledger';
import type { MockBank } from '../runtime';
import { accountName, customerTransactions, nemParty, transferView } from '../views';
import type { Person, ScheduledRecord, TransferRecord } from '../world';

type Destination = Schema<'TransferDestination'>;

/** TRF-8: the first payment above this to a new beneficiary needs step-up or a delay. */
export const COOLING_OFF_THRESHOLD = naira(100_000);
export const COOLING_OFF_MINUTES = 30;
/** How long the sandbox interbank partner takes to answer. */
const PARTNER_DELAY_MS = 4_000;
/** Demo fraud review clears on its own; the console (T20) decides it for real. */
const REVIEW_MINUTES = 2;
const MODEL_VERSION = 'rules-mock-1';

interface Resolved {
  rail: Schema<'TransferRail'>;
  person: Person | null;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  name: string;
  beneficiary: Schema<'Beneficiary'> | null;
}

function personByAccount(bank: MockBank, accountNumber: string): Person | undefined {
  return bank.world.people.find((p) => p.accountNumber === accountNumber);
}

function assertNotSelf(bank: MockBank, accountNumber: string) {
  const own = Object.values(bank.world.accountMeta).some((m) => m.accountNumber === accountNumber);
  if (own) {
    throw problem(422, 'validation_failed', 'That is your own account', {
      detail: 'Move money between your own accounts from the account screen.',
    });
  }
}

export function resolveDestination(bank: MockBank, destination: Destination): Resolved {
  if (destination.kind === 'beneficiary') {
    const b = bank.world.beneficiaries.find((x) => x.id === destination.beneficiary_id);
    if (!b) throw notFound('Beneficiary');
    const resolved = resolveDestination(
      bank,
      b.kind === 'nem'
        ? { kind: 'nem', account_number: b.account_number }
        : {
            kind: 'bank',
            bank_code: b.bank_code,
            account_number: b.account_number,
            account_name: b.name,
          },
    );
    return { ...resolved, beneficiary: b };
  }
  assertNotSelf(bank, destination.account_number);
  const saved = (accountNumber: string, bankCode: string) =>
    bank.world.beneficiaries.find(
      (b) => b.account_number === accountNumber && b.bank_code === bankCode,
    ) ?? null;
  const isNem = destination.kind === 'nem' || destination.bank_code === NEM_BANK.code;
  if (isNem) {
    const person = personByAccount(bank, destination.account_number);
    if (!person) throw problem(404, 'account_not_found', 'No Nem account has that number');
    return {
      rail: 'internal',
      person,
      bankCode: NEM_BANK.code,
      bankName: NEM_BANK.name,
      accountNumber: person.accountNumber,
      name: `${person.firstName} ${person.lastName}`,
      beneficiary: saved(person.accountNumber, NEM_BANK.code),
    };
  }
  const target = bankByCode(destination.bank_code);
  const name = externalAccountName(destination.account_number);
  if (!target) throw problem(422, 'validation_failed', 'Pick a bank from the list');
  if (!name) throw problem(404, 'account_not_found', 'We could not find that account');
  return {
    rail: 'interbank',
    person: null,
    bankCode: target.code,
    bankName: target.name,
    accountNumber: destination.account_number,
    name,
    beneficiary: saved(destination.account_number, target.code),
  };
}

function partyOf(resolved: Resolved): Schema<'TransferParty'> {
  if (resolved.person) return nemParty(resolved.person);
  return {
    name: resolved.name,
    nemtag: null,
    bank_code: resolved.bankCode,
    bank_name: resolved.bankName,
    account_number_masked: maskAccount(resolved.accountNumber),
  };
}

const feeFor = (amount: Money, rail: Schema<'TransferRail'>) =>
  transferFee(amount, rail === 'internal' ? 'internal' : 'external');

function isNewBeneficiary(bank: MockBank, resolved: Resolved): boolean {
  const b = resolved.beneficiary;
  if (!b) return true;
  return !b.last_paid_at && Boolean(b.cooling_off_until && b.cooling_off_until > bank.nowIso());
}

function coolingOff(bank: MockBank, resolved: Resolved, amount: Money) {
  return isNewBeneficiary(bank, resolved) && amount.amount > COOLING_OFF_THRESHOLD.amount;
}

function deviceCoolOff(bank: MockBank): boolean {
  const device = bank.world.devices.find((d) => d.id === bank.world.currentDeviceId);
  return Boolean(device?.cool_off_until && device.cool_off_until > bank.nowIso());
}

export function limitStatus(bank: MockBank, accountId: string): Schema<'LimitStatus'> {
  const limits = bank.limits();
  const tierLimit = KYC_TIERS[limits.tier].dailyLimit;
  const self = limits.selfDailyLimit;
  const daily = self && self.amount < tierLimit.amount ? self : tierLimit;
  const used = spentToday(bank.ledger, accountId, bank.nowIso());
  const remaining = daily.amount - used.amount;
  return {
    kyc_tier: limits.tier,
    daily_limit: api(daily),
    used_today: api(used),
    remaining_today: api(money(remaining > 0n ? remaining : 0n, daily.currency)),
    self_set: daily === self,
    cool_off_active: deviceCoolOff(bank),
  };
}

/** Rules first, model later (M30): explainable reasons the risk screen can show. */
export function assessRisk(bank: MockBank, amount: Money): Schema<'RiskAssessment'> {
  const since = new Date(bank.now().getTime() - 90 * 86_400_000).toISOString();
  const recent = customerTransactions(bank).filter(
    (t) => t.type === 'transfer_out' && t.status === 'completed' && t.created_at >= since,
  );
  const average =
    recent.length > 0
      ? recent.reduce((s, t) => s + BigInt(t.amount.amount_minor), 0n) / BigInt(recent.length)
      : 0n;
  const reasons: Schema<'RiskReason'>[] = [];
  let decision: Schema<'RiskDecision'> = 'allow';
  let score = 0.04;
  if (amount.amount >= naira(2_000_000).amount) {
    decision = 'hold';
    score = 0.86;
    reasons.push({
      code: 'large_amount',
      severity: 'high',
      message:
        'This is far larger than anything you have sent before, so a person checks it first.',
    });
  } else if (
    average > 0n &&
    amount.amount > average * 10n &&
    amount.amount > naira(50_000).amount
  ) {
    decision = 'step_up';
    score = 0.48;
    reasons.push({
      code: 'unusual_amount',
      severity: 'medium',
      message: `You usually send about ${formatMoney(money(average, 'NGN'))}. Confirm it is really you.`,
    });
  }
  if (deviceCoolOff(bank)) {
    if (decision === 'allow') decision = 'step_up';
    score = Math.max(score, 0.52);
    reasons.push({
      code: 'new_device',
      severity: 'medium',
      message: 'You signed in on this device in the last 24 hours.',
    });
  }
  return { decision, score, reasons, model_version: MODEL_VERSION };
}

function event(record: TransferRecord, status: string, label: string, at: string, detail?: string) {
  record.timeline.push({ status, label, at, detail: detail ?? null });
}

function setStatus(bank: MockBank, record: TransferRecord, status: Schema<'TransferStatus'>) {
  record.status = status;
  record.updated_at = bank.nowIso();
}

function fail(bank: MockBank, record: TransferRecord, detail: string) {
  if (record.holdId && bank.ledger.state.holds[record.holdId]?.status === 'active') {
    failExternalTransfer(bank.ledger, record.holdId);
  }
  record.holdId = null;
  record.dueAt = null;
  setStatus(bank, record, 'failed');
  event(record, 'failed', 'Transfer failed', bank.nowIso(), detail);
  event(record, 'reversed', 'Money returned to your account', bank.nowIso());
  bank.notify({
    category: 'transactions',
    title: 'Transfer failed, money returned',
    body: `${formatMoney(fromApi(record.amount))} to ${record.recipient.name} did not go through. ${detail}`,
    deep_link: `nembank://transfers/${record.id}`,
  });
}

function releaseHold(bank: MockBank, record: TransferRecord) {
  if (record.holdId && bank.ledger.state.holds[record.holdId]?.status === 'active') {
    bank.ledger.releaseHold(record.holdId);
  }
  record.holdId = null;
}

/** Moves the money: instantly for Nem-to-Nem, through the partner saga otherwise. */
function proceed(bank: MockBank, record: TransferRecord): void {
  releaseHold(bank, record);
  const amount = fromApi(record.amount);
  const at = bank.nowIso();
  const debit = {
    id: record.transaction_id!,
    accountId: record.source_account_id,
    direction: 'debit' as const,
    type: 'transfer_out' as const,
    category: record.category ?? 'transfers',
    narration: record.narration,
    counterparty: {
      name: record.recipient.name,
      nemtag: record.recipient.nemtag ?? null,
      bank_name: record.recipient.bank_name,
      account_number_masked: record.recipient.account_number_masked,
    },
    transferId: record.id,
  };
  if (record.destination.kind === 'nem') {
    const toAccountId = record.destination.accountId;
    const person = bank.world.people.find((p) => p.accountId === toAccountId)!;
    transferInternal(bank.ledger, {
      fromAccountId: record.source_account_id,
      toAccountId,
      recipientTier: person.tier,
      amount,
      reference: record.reference,
      idempotencyKey: `transfer:${record.id}`,
      limits: bank.limits(),
      metadata: {
        txns: [
          debit,
          {
            id: bank.id(),
            accountId: toAccountId,
            direction: 'credit',
            type: 'transfer_in',
            category: 'transfers',
            narration: record.narration,
            counterparty: { name: accountName(bank), nemtag: bank.user.nemtag },
          },
        ],
      },
    });
    setStatus(bank, record, 'completed');
    event(record, 'completed', 'Sent instantly', at);
  } else {
    const hold = startExternalTransfer(bank.ledger, {
      fromAccountId: record.source_account_id,
      amount,
      reference: record.reference,
      idempotencyKey: `transfer:${record.id}`,
      limits: bank.limits(),
    });
    record.holdId = hold.id;
    record.dueAt = new Date(bank.now().getTime() + PARTNER_DELAY_MS).toISOString();
    record.willFail = bank.world.failNextTransfer;
    bank.world.failNextTransfer = false;
    setStatus(bank, record, 'processing');
    event(record, 'processing', `Sent to ${record.recipient.bank_name}`, at);
  }
  markPaid(bank, record);
}

function markPaid(bank: MockBank, record: TransferRecord) {
  const b = bank.world.beneficiaries.find((x) => x.id === record.beneficiaryId);
  if (b) b.last_paid_at = bank.nowIso();
}

export interface SendInput {
  sourceAccountId: string;
  destination: Destination;
  amount: Schema<'Money'>;
  narration?: string;
  category?: Schema<'Category'>;
  saveBeneficiary?: boolean;
  stepUpToken?: string;
  paysRequestId?: string;
}

/** One transfer through every rule: limits, fees, risk, cooling-off, then the money. */
export function sendMoney(bank: MockBank, input: SendInput): TransferRecord {
  bank.assertCanSend();
  const source = bank.ownAccount(input.sourceAccountId);
  const amount = positive(input.amount, 'NGN');
  if (source.currency !== 'NGN') {
    throw problem(422, 'validation_failed', 'Transfers go out from your naira account');
  }
  const resolved = resolveDestination(bank, input.destination);
  const single = bank.world.selfLimits.single;
  if (single && amount.amount > fromApi(single).amount) {
    throw problem(422, 'limit_exceeded', 'Above your single-transfer limit', {
      detail: `Your own limit is ${formatMoney(fromApi(single))} per transfer.`,
    });
  }
  const fee = feeFor(amount, resolved.rail);
  assertWithinDailyLimit(bank.ledger, source.id, amount, bank.limits(), bank.nowIso());
  if (bank.ledger.available(source.id).amount < add(amount, fee).amount) {
    throw problem(422, 'insufficient_funds', 'Insufficient funds', {
      detail: `You need ${formatMoney(add(amount, fee))} including the fee.`,
    });
  }

  const at = bank.nowIso();
  const risk = assessRisk(bank, amount);
  const record: TransferRecord = {
    id: bank.id(),
    reference: bank.reference(),
    status: 'created',
    rail: resolved.rail,
    source_account_id: source.id,
    recipient: partyOf(resolved),
    amount: api(amount),
    fee: api(fee),
    total_debit: api(add(amount, fee)),
    narration: input.narration?.trim() || `Transfer to ${resolved.name}`,
    risk,
    step_up_id: null,
    release_at: null,
    timeline: [{ status: 'created', label: 'Transfer created', at, detail: null }],
    reversal: null,
    transaction_id: bank.id(),
    created_at: at,
    updated_at: at,
    destination: resolved.person
      ? { kind: 'nem', accountId: resolved.person.accountId }
      : { kind: 'bank', bankCode: resolved.bankCode },
    beneficiaryId: resolved.beneficiary?.id ?? null,
    holdId: null,
    dueAt: null,
    category: input.category ?? null,
    paysRequestId: input.paysRequestId ?? null,
    willFail: false,
  };
  event(record, 'risk_checked', 'Security checks done', at);
  bank.world.transfers.push(record);

  const steppedUp = bank.hasValidStepUp(input.stepUpToken, 'transfer');
  const hold = (reason: 'fraud_review' | 'delayed_transfer') =>
    bank.ledger.placeHold({
      accountId: source.id,
      amount: add(amount, fee),
      reason,
      reference: record.reference,
      limitUsage: amount,
    }).id;

  if (risk.decision === 'hold') {
    record.holdId = hold('fraud_review');
    record.dueAt = addMinutes(bank.now(), REVIEW_MINUTES).toISOString();
    setStatus(bank, record, 'held_for_review');
    event(record, 'held_for_review', 'Held for a quick review', at, risk.reasons[0]?.message);
  } else if (risk.decision === 'step_up' && !steppedUp) {
    setStatus(bank, record, 'pending_step_up');
    event(record, 'pending_step_up', 'Waiting for you to confirm it is you', at);
  } else if (coolingOff(bank, resolved, amount) && !steppedUp) {
    record.holdId = hold('delayed_transfer');
    record.release_at = addMinutes(bank.now(), COOLING_OFF_MINUTES).toISOString();
    record.dueAt = record.release_at;
    setStatus(bank, record, 'delayed');
    event(
      record,
      'delayed',
      `New beneficiary: sends in ${COOLING_OFF_MINUTES} minutes`,
      at,
      'Confirm with your PIN or OTP to send it now, or cancel it before then.',
    );
  } else {
    proceed(bank, record);
  }

  if (input.saveBeneficiary && !resolved.beneficiary) {
    const created = saveBeneficiary(bank, resolved, false, null);
    created.last_paid_at = record.status === 'completed' ? at : null;
    record.beneficiaryId = created.id;
  }
  return record;
}

function saveBeneficiary(
  bank: MockBank,
  resolved: Resolved,
  favourite: boolean,
  nickname: string | null,
): Schema<'Beneficiary'> {
  const at = bank.nowIso();
  const beneficiary: Schema<'Beneficiary'> = {
    id: bank.id(),
    kind: resolved.person ? 'nem' : 'bank',
    name: resolved.name,
    nickname,
    nemtag: resolved.person?.nemtag ?? null,
    bank_code: resolved.bankCode,
    bank_name: resolved.bankName,
    account_number: resolved.accountNumber,
    favourite,
    cooling_off_until: new Date(bank.now().getTime() + 24 * 3_600_000).toISOString(),
    last_paid_at: null,
    created_at: at,
  };
  bank.world.beneficiaries.push(beneficiary);
  return beneficiary;
}

/** Partner answers, cooling-off delays and reviews that have come due. */
export function processDueTransfers(bank: MockBank): boolean {
  const now = bank.nowIso();
  const due = bank.world.transfers.filter((t) => t.dueAt && t.dueAt <= now);
  for (const record of due) {
    const at = record.dueAt!;
    record.dueAt = null;
    try {
      if (record.status === 'processing') {
        if (record.willFail) {
          fail(bank, record, 'The recipient bank did not respond (simulated failure).');
          continue;
        }
        settleExternalTransfer(bank.ledger, record.holdId!, `settle:${record.id}`, {
          txns: [
            {
              id: record.transaction_id!,
              accountId: record.source_account_id,
              direction: 'debit',
              type: 'transfer_out',
              category: record.category ?? 'transfers',
              narration: record.narration,
              counterparty: {
                name: record.recipient.name,
                bank_name: record.recipient.bank_name,
                account_number_masked: record.recipient.account_number_masked,
              },
              transferId: record.id,
            },
          ],
        });
        record.holdId = null;
        setStatus(bank, record, 'completed');
        event(record, 'completed', `Received by ${record.recipient.bank_name}`, at);
      } else if (record.status === 'delayed' || record.status === 'held_for_review') {
        event(
          record,
          'released',
          record.status === 'delayed' ? 'Cooling-off ended' : 'Review cleared',
          at,
        );
        proceed(bank, record);
      }
    } catch (error) {
      fail(bank, record, error instanceof Error ? error.message : 'Something went wrong.');
    }
  }
  return due.length > 0;
}

const NEXT_RUN: Record<Schema<'ScheduleFrequency'>, number> = {
  once: 0,
  daily: 1,
  weekly: 7,
  monthly: 30,
};

function advance(at: string, frequency: Schema<'ScheduleFrequency'>): string | null {
  if (frequency === 'once') return null;
  const date = new Date(at);
  if (frequency === 'monthly') date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCDate(date.getUTCDate() + NEXT_RUN[frequency]);
  return date.toISOString();
}

export function processSchedules(bank: MockBank): boolean {
  const now = bank.nowIso();
  const due = bank.world.scheduled.filter(
    (s) => s.status === 'active' && s.next_run_at && s.next_run_at <= now,
  );
  for (const schedule of due) {
    const at = schedule.next_run_at!;
    let status: Schema<'TransferStatus'> = 'failed';
    let transferId: string | null = null;
    try {
      const record = sendMoney(bank, {
        sourceAccountId: schedule.source_account_id,
        destination: schedule.destination,
        amount: schedule.amount,
        narration: schedule.narration,
      });
      status = record.status;
      transferId = record.id;
    } catch (error) {
      bank.notify({
        category: 'transactions',
        title: 'Scheduled transfer skipped',
        body: `${schedule.narration}: ${error instanceof Error ? error.message : 'it could not be sent'}.`,
        deep_link: `nembank://transfers/scheduled/${schedule.id}`,
      });
    }
    schedule.run_count += 1;
    schedule.last_run = { at, status, transfer_id: transferId };
    const next = advance(at, schedule.frequency);
    const ended = !next || (schedule.ends_on && next.slice(0, 10) > schedule.ends_on);
    schedule.next_run_at = ended ? null : next;
    if (ended) schedule.status = 'completed';
  }
  return due.length > 0;
}

function findTransfer(bank: MockBank, id: string): TransferRecord {
  const record = bank.world.transfers.find((t) => t.id === id);
  if (!record) throw notFound('Transfer');
  return record;
}

export function transfersRepo(bank: MockBank): TransfersRepo {
  const find = (id: string) => bank.world.transfers.find((t) => t.id === id);
  const schedule = (id: string): ScheduledRecord => {
    const s = bank.world.scheduled.find((x) => x.id === id);
    if (!s) throw notFound('Scheduled transfer');
    return s;
  };
  const scheduleView = ({ destination: _destination, ...s }: ScheduledRecord) => s;
  return {
    async quote({ body }) {
      const source = bank.ownAccount(body.source_account_id);
      const amount = positive(body.amount, 'NGN');
      const resolved = resolveDestination(bank, body.destination);
      const fee = feeFor(amount, resolved.rail);
      return {
        quote_id: bank.id(),
        amount: api(amount),
        fee: api(fee),
        fees:
          fee.amount > 0n
            ? [{ code: 'transfer_fee', label: 'Transfer fee', amount: api(fee) }]
            : [],
        total_debit: api(add(amount, fee)),
        limits: limitStatus(bank, source.id),
        cooling_off: coolingOff(bank, resolved, amount)
          ? {
              reason: 'new_beneficiary',
              delay_minutes: COOLING_OFF_MINUTES,
              step_up_skips_delay: true,
            }
          : deviceCoolOff(bank)
            ? { reason: 'new_device', delay_minutes: 0, step_up_skips_delay: true }
            : null,
        rail: resolved.rail,
        expires_at: addMinutes(bank.now(), 5).toISOString(),
      };
    },
    async list({ query } = {}) {
      const all = newestFirst(bank.world.transfers).filter(
        (t) => !query?.status || t.status === query.status,
      );
      const page = paginate(all, query);
      return { data: page.data.map(transferView), page: page.page };
    },
    async create({ body, idempotencyKey, stepUpToken }) {
      const record = bank.idempotent(idempotencyKey, body, find, () =>
        sendMoney(bank, {
          sourceAccountId: body.source_account_id,
          destination: body.destination,
          amount: body.amount,
          narration: body.narration,
          category: body.category,
          saveBeneficiary: body.save_beneficiary,
          stepUpToken,
        }),
      );
      return transferView(record);
    },
    async get({ path }) {
      return transferView(findTransfer(bank, path.transfer_id));
    },
    async stepUp({ path, stepUpToken, idempotencyKey }) {
      const record = findTransfer(bank, path.transfer_id);
      const replay = bank.world.idempotency[idempotencyKey];
      if (replay?.id === record.id) return transferView(record);
      if (record.status !== 'pending_step_up' && record.status !== 'delayed') {
        throw problem(409, 'invalid_state', 'This transfer does not need confirming');
      }
      bank.consumeStepUp(stepUpToken, 'transfer');
      bank.world.idempotency[idempotencyKey] = { fingerprint: record.id, id: record.id };
      event(record, 'stepped_up', 'Confirmed by you', bank.nowIso());
      proceed(bank, record);
      return transferView(record);
    },
    async cancel({ path }) {
      const record = findTransfer(bank, path.transfer_id);
      if (record.status === 'cancelled') return transferView(record);
      if (!['pending_step_up', 'delayed', 'held_for_review'].includes(record.status)) {
        throw problem(409, 'invalid_state', 'This transfer can no longer be cancelled');
      }
      releaseHold(bank, record);
      record.dueAt = null;
      setStatus(bank, record, 'cancelled');
      event(record, 'cancelled', 'Cancelled by you', bank.nowIso());
      return transferView(record);
    },
    async createInternational() {
      throw problem(403, 'paid_feature_required', 'International transfers need a partner', {
        detail: 'Sending abroad needs a licensed remittance partner (TRF-14).',
        feature: 'international_transfers',
      });
    },
    async listScheduled({ query } = {}) {
      const page = paginate(newestFirst(bank.world.scheduled), query);
      return { data: page.data.map(scheduleView), page: page.page };
    },
    async createScheduled({ body, idempotencyKey }) {
      const record = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.scheduled.find((s) => s.id === id),
        () => {
          bank.ownAccount(body.source_account_id);
          const amount = positive(body.amount, 'NGN');
          const resolved = resolveDestination(bank, body.destination);
          if (body.start_at < bank.nowIso().slice(0, 16)) {
            throw problem(422, 'validation_failed', 'Pick a start time in the future');
          }
          const s: ScheduledRecord = {
            id: bank.id(),
            source_account_id: body.source_account_id,
            recipient: partyOf(resolved),
            amount: api(amount),
            narration: body.narration?.trim() || `Scheduled transfer to ${resolved.name}`,
            frequency: body.frequency,
            status: 'active',
            next_run_at: body.start_at,
            ends_on: body.ends_on ?? null,
            run_count: 0,
            last_run: null,
            created_at: bank.nowIso(),
            destination: body.destination,
          };
          bank.world.scheduled.push(s);
          return s;
        },
      );
      return scheduleView(record);
    },
    async getScheduled({ path }) {
      return scheduleView(schedule(path.schedule_id));
    },
    async updateScheduled({ path, body }) {
      const s = schedule(path.schedule_id);
      if (s.status === 'cancelled' || s.status === 'completed') {
        throw problem(409, 'invalid_state', 'This schedule has ended');
      }
      if (body.status) s.status = body.status;
      if (body.amount) s.amount = api(positive(body.amount, 'NGN'));
      if (body.next_run_at) s.next_run_at = body.next_run_at;
      return scheduleView(s);
    },
    async cancelScheduled({ path }) {
      const s = schedule(path.schedule_id);
      s.status = 'cancelled';
      s.next_run_at = null;
    },
  };
}

export function payeesRepo(bank: MockBank): PayeesRepo {
  return {
    async listBanks() {
      return { data: BANKS };
    },
    async resolve({ body }) {
      let resolved: Resolved;
      if (body.kind === 'nem') {
        const q = body.query.trim().replace(/^@/, '').toLowerCase();
        const digits = q.replace(/\D/g, '');
        const person = bank.world.people.find(
          (p) =>
            p.nemtag === q ||
            p.accountNumber === digits ||
            (digits.length >= 10 && `0${digits.slice(-10)}` === p.accountNumber),
        );
        if (!person) throw problem(404, 'account_not_found', 'No Nem user matches that');
        resolved = resolveDestination(bank, { kind: 'nem', account_number: person.accountNumber });
      } else {
        resolved = resolveDestination(bank, {
          kind: 'bank',
          bank_code: body.bank_code,
          account_number: body.account_number,
          account_name: body.expected_name ?? '',
        });
      }
      return {
        kind: resolved.person ? 'nem' : 'bank',
        name: resolved.name,
        nemtag: resolved.person?.nemtag ?? null,
        user_id: resolved.person?.userId ?? null,
        avatar_url: null,
        bank_code: resolved.bankCode,
        bank_name: resolved.bankName,
        account_number: resolved.accountNumber,
        name_match:
          body.kind === 'bank' && body.expected_name
            ? nameMatch(body.expected_name, resolved.name)
            : null,
        is_saved_beneficiary: resolved.beneficiary !== null,
        beneficiary_id: resolved.beneficiary?.id ?? null,
      };
    },
  };
}

export function beneficiariesRepo(bank: MockBank): BeneficiariesRepo {
  const find = (id: string) => {
    const b = bank.world.beneficiaries.find((x) => x.id === id);
    if (!b) throw notFound('Beneficiary');
    return b;
  };
  return {
    async list({ query } = {}) {
      const q = query?.q?.trim().toLowerCase();
      const items = bank.world.beneficiaries
        .filter((b) => query?.favourite === undefined || b.favourite === query.favourite)
        .filter(
          (b) =>
            !q ||
            [b.name, b.nickname ?? '', b.nemtag ?? '', b.account_number, b.bank_name].some((f) =>
              f.toLowerCase().includes(q),
            ),
        )
        .sort(
          (a, b) =>
            Number(b.favourite) - Number(a.favourite) ||
            (b.last_paid_at ?? '').localeCompare(a.last_paid_at ?? '') ||
            a.name.localeCompare(b.name),
        );
      return paginate(items, query);
    },
    async create({ body }) {
      const resolved = resolveDestination(bank, body.destination);
      if (resolved.beneficiary) {
        throw problem(409, 'beneficiary_exists', 'Already saved', {
          detail: `${resolved.name} is already in your beneficiaries.`,
        });
      }
      return saveBeneficiary(bank, resolved, body.favourite, body.nickname?.trim() || null);
    },
    async update({ path, body }) {
      const b = find(path.beneficiary_id);
      if (body.nickname !== undefined) b.nickname = body.nickname?.trim() || null;
      if (body.favourite !== undefined) b.favourite = body.favourite;
      return b;
    },
    async remove({ path }) {
      find(path.beneficiary_id);
      bank.world.beneficiaries = bank.world.beneficiaries.filter(
        (b) => b.id !== path.beneficiary_id,
      );
    },
  };
}
