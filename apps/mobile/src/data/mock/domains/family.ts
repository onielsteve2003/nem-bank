import type { Schema } from '@nem/contracts';
import { add, money, negate, transferFee } from '@nem/shared';

import { isApiError, problem } from '../../errors';
import type { FamilyRepo } from '../../repositories';
import { addDays, api, fromApi, newestFirst, notFound, paginate, positive } from '../convert';
import { NEM_BANK } from '../directory';
import { transferInternal } from '../ledger';
import type { MockBank } from '../runtime';
import { accountName, nemParty, partyOf, transactionsFor } from '../views';
import type { DependantRecord } from '../world';

// Family (FAM-1..3): a dependant has their own login and NGN account. Allowances
// are recurring transfers from the parent; transfers above the approval
// threshold wait for the parent.

const APPROVAL_TTL_HOURS = 24;
/** A new dependant asks for one approval soon after setup, so the flow can be shown. */
const FIRST_REQUEST_MS = 30_000;

function nextAllowance(
  from: Date,
  allowance: Pick<Schema<'Allowance'>, 'frequency' | 'day'>,
): string {
  const next = new Date(from);
  if (allowance.frequency === 'weekly') {
    const target = (allowance.day ?? 5) % 7;
    const diff = (target - next.getUTCDay() + 7) % 7 || 7;
    next.setUTCDate(next.getUTCDate() + diff);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1, Math.min(allowance.day ?? 1, 28));
  }
  next.setUTCHours(8, 0, 0, 0);
  return next.toISOString();
}

function dependantView(bank: MockBank, d: DependantRecord): Schema<'Dependant'> {
  const { person: _person, ...rest } = d;
  return { ...rest, balance: api(bank.ledger.account(d.account_id).balance) };
}

function age(dateOfBirth: string, now: Date): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let years = now.getUTCFullYear() - dob.getUTCFullYear();
  if (
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())
  )
    years -= 1;
  return years;
}

export function processFamily(bank: MockBank): boolean {
  const now = bank.nowIso();
  let changed = false;
  for (const d of bank.world.dependants) {
    const allowance = d.allowance;
    if (allowance?.next_run_at && allowance.next_run_at <= now && !d.controls.paused) {
      try {
        transferInternal(bank.ledger, {
          fromAccountId: allowance.source_account_id,
          toAccountId: d.account_id,
          recipientTier: 1,
          amount: fromApi(allowance.amount),
          reference: bank.reference(),
          idempotencyKey: `allowance:${d.id}:${allowance.next_run_at}`,
          limits: bank.limits(),
          metadata: {
            txns: [
              {
                id: bank.id(),
                accountId: allowance.source_account_id,
                direction: 'debit',
                type: 'transfer_out',
                category: 'family',
                narration: `Allowance for ${d.profile.name}`,
                counterparty: { name: d.profile.name, nemtag: d.profile.nemtag },
              },
              {
                id: bank.id(),
                accountId: d.account_id,
                direction: 'credit',
                type: 'transfer_in',
                category: 'family',
                narration: 'Allowance',
                counterparty: { name: accountName(bank), nemtag: bank.user.nemtag },
              },
            ],
          },
        });
      } catch (error) {
        if (!isApiError(error)) throw error;
        bank.notify({
          category: 'transactions',
          title: 'Allowance not sent',
          body: `${d.profile.name}'s allowance could not be sent: ${error.message}.`,
          deep_link: `nembank://family/${d.id}`,
        });
      }
      d.allowance = {
        ...allowance,
        next_run_at: nextAllowance(new Date(allowance.next_run_at), allowance),
      };
      changed = true;
    }
    const asked = bank.world.approvals.some((a) => a.dependant.user_id === d.profile.user_id);
    if (!asked && Date.parse(now) - Date.parse(d.created_at) >= FIRST_REQUEST_MS) {
      const friend = bank.world.people[0]!;
      const amount = add(fromApi(d.controls.approval_threshold), money(50_000n, 'NGN'));
      bank.world.approvals.push({
        id: bank.id(),
        dependant: d.profile,
        recipient: nemParty(friend),
        amount: api(amount),
        narration: 'Textbooks',
        status: 'pending',
        transfer_id: null,
        created_at: now,
        expires_at: addDays(bank.now(), APPROVAL_TTL_HOURS / 24).toISOString(),
      });
      bank.notify({
        category: 'transactions',
        title: `${d.profile.name} needs your approval`,
        body: 'Tap to approve or decline the transfer.',
        deep_link: 'nembank://family/approvals',
      });
      changed = true;
    }
  }
  for (const a of bank.world.approvals) {
    if (a.status === 'pending' && a.expires_at <= now) {
      a.status = 'expired';
      changed = true;
    }
  }
  return changed;
}

export function familyRepo(bank: MockBank): FamilyRepo {
  const find = (id: string) => {
    const d = bank.world.dependants.find((x) => x.id === id);
    if (!d) throw notFound('Dependant');
    return d;
  };
  const approval = (id: string) => {
    const a = bank.world.approvals.find((x) => x.id === id);
    if (!a) throw notFound('Approval');
    return a;
  };
  const checkControls = (c: Schema<'DependantControls'>) => {
    positive(c.daily_spend_limit, 'NGN');
    positive(c.approval_threshold, 'NGN');
  };
  return {
    async listDependants() {
      return { data: bank.world.dependants.map((d) => dependantView(bank, d)) };
    },
    async createDependant({ body, stepUpToken }) {
      bank.consumeStepUp(stepUpToken, 'new_beneficiary');
      const years = age(body.date_of_birth, bank.now());
      if (years < 6 || years >= 18)
        throw problem(422, 'validation_failed', 'Dependants are 6 to 17 years old');
      const tag = body.nemtag.toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,20}$/.test(tag))
        throw problem(422, 'validation_failed', 'Use 3–20 letters, numbers or _');
      if (bank.world.people.some((p) => p.nemtag === tag) || tag === bank.user.nemtag) {
        throw problem(409, 'nemtag_taken', `@${tag} is taken`);
      }
      checkControls(body.controls);
      const userId = bank.id();
      const account = bank.ledger.openAccount({
        ownerType: 'customer',
        ownerId: userId,
        kind: 'customer_current',
        currency: 'NGN',
      });
      const accountNumber = String(4_202_080_000 + bank.world.dependants.length * 13);
      bank.world.accountMeta[account.id] = { accountNumber, nickname: null };
      const person = {
        userId,
        firstName: body.first_name.trim(),
        lastName: body.last_name.trim(),
        nemtag: tag,
        accountId: account.id,
        accountNumber,
        tier: 1 as const,
      };
      const record: DependantRecord = {
        id: bank.id(),
        person,
        profile: partyOf(person),
        date_of_birth: body.date_of_birth,
        account_id: account.id,
        kid_mode: true,
        controls: body.controls,
        allowance: null,
        created_at: bank.nowIso(),
      };
      bank.world.dependants.push(record);
      return {
        dependant: dependantView(bank, record),
        setup_code: String(Math.floor(100_000 + Math.random() * 900_000)),
        setup_code_expires_at: addDays(bank.now(), 1).toISOString(),
      };
    },
    async getDependant({ path }) {
      return dependantView(bank, find(path.dependant_id));
    },
    async updateControls({ path, body }) {
      const d = find(path.dependant_id);
      if (body.kid_mode !== undefined) d.kid_mode = body.kid_mode;
      if (body.controls) {
        checkControls(body.controls);
        d.controls = body.controls;
      }
      return dependantView(bank, d);
    },
    async setAllowance({ path, body }) {
      const d = find(path.dependant_id);
      const source = bank.ownAccount(body.source_account_id);
      if (source.currency !== 'NGN')
        throw problem(422, 'validation_failed', 'Allowances are paid in naira');
      positive(body.amount, 'NGN');
      if (
        body.day !== undefined &&
        (body.frequency === 'weekly' ? body.day < 0 || body.day > 6 : body.day < 1 || body.day > 28)
      ) {
        throw problem(
          422,
          'validation_failed',
          body.frequency === 'weekly' ? 'Pick a weekday' : 'Pick a day from 1 to 28',
        );
      }
      d.allowance = { ...body, next_run_at: nextAllowance(bank.now(), body) };
      return dependantView(bank, d);
    },
    async stopAllowance({ path }) {
      find(path.dependant_id).allowance = null;
    },
    async listActivity({ path, query }) {
      return paginate(transactionsFor(bank, [find(path.dependant_id).account_id]), query);
    },
    async listApprovals({ query } = {}) {
      return {
        data: newestFirst(bank.world.approvals).filter(
          (a) => !query?.status || a.status === query.status,
        ),
      };
    },
    async approve({ path, idempotencyKey }) {
      const a = approval(path.approval_id);
      if (a.status === 'approved' && bank.world.idempotency[idempotencyKey]?.id === a.id) return a;
      if (a.status !== 'pending')
        throw problem(409, 'invalid_state', 'This request is no longer open');
      const d = bank.world.dependants.find((x) => x.profile.user_id === a.dependant.user_id);
      if (!d) throw notFound('Dependant');
      const amount = positive(a.amount, 'NGN');
      const transferId = bank.id();
      const debit = {
        id: bank.id(),
        accountId: d.account_id,
        direction: 'debit' as const,
        type: 'transfer_out' as const,
        category: 'transfers' as const,
        narration: a.narration,
        counterparty: {
          name: a.recipient.name,
          nemtag: a.recipient.nemtag ?? null,
          bank_name: a.recipient.bank_name,
        },
        transferId,
      };
      const friend = bank.world.people.find((p) => p.nemtag === a.recipient.nemtag);
      if (a.recipient.bank_code === NEM_BANK.code && friend) {
        transferInternal(bank.ledger, {
          fromAccountId: d.account_id,
          toAccountId: friend.accountId,
          recipientTier: friend.tier,
          amount,
          reference: bank.reference(),
          idempotencyKey: `approval:${a.id}`,
          limits: { tier: 1 },
          metadata: { txns: [debit] },
        });
      } else {
        const fee = transferFee(amount, 'external');
        bank.ledger.post({
          kind: 'transfer_external',
          reference: bank.reference(),
          idempotencyKey: `approval:${a.id}`,
          postings: [
            { accountId: d.account_id, amount: negate(add(amount, fee)) },
            { accountId: bank.ledger.systemAccount('partner_settlement', 'NGN').id, amount },
            { accountId: bank.ledger.systemAccount('fee_income', 'NGN').id, amount: fee },
          ],
          metadata: { fee: fee.amount.toString(), txns: [debit] },
          limitUsage: { accountId: d.account_id, amount },
        });
      }
      a.status = 'approved';
      a.transfer_id = transferId;
      bank.world.idempotency[idempotencyKey] = { fingerprint: a.id, id: a.id };
      return a;
    },
    async decline({ path }) {
      const a = approval(path.approval_id);
      if (a.status !== 'pending')
        throw problem(409, 'invalid_state', 'This request is no longer open');
      a.status = 'declined';
      return a;
    },
  };
}
