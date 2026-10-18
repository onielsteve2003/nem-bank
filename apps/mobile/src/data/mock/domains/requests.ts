import type { Schema } from '@nem/contracts';
import { money, sum } from '@nem/shared';

import { problem } from '../../errors';
import type { MoneyRequestsRepo, PaymentLinksRepo } from '../../repositories';
import {
  addDays,
  addMinutes,
  api,
  fromApi,
  newestFirst,
  notFound,
  paginate,
  positive,
} from '../convert';
import { NEM_BANK } from '../directory';
import { sha256Hex } from '../documents';
import { transferInternal } from '../ledger';
import type { MockBank } from '../runtime';
import { accountName, me, partyOf, personByNemtag, transferView } from '../views';
import type { Person } from '../world';
import { sendMoney } from './transfers';

/** Friends pay outgoing requests back after this long, so the demo shows money arriving. */
const PAY_BACK_MS = 15_000;
const REMIND_EVERY_MS = 60 * 60_000;
const QR_KEY_ID = 'mock-qr-1';
const QR_TTL_MINUTES = 15;

function requestFinder(bank: MockBank) {
  const r = bank.world.moneyRequests;
  return (id: string) => {
    const found = r.find((x) => x.id === id);
    if (!found) throw notFound('Request');
    return found;
  };
}

/** A friend pays one of the customer's requests: their money moves Nem-to-Nem. */
function payBack(bank: MockBank, request: Schema<'MoneyRequest'>, person: Person) {
  const ngn = bank.accountIn('NGN');
  if (!ngn) return;
  const amount = fromApi(request.amount);
  const transferId = bank.id();
  const entry = transferInternal(bank.ledger, {
    fromAccountId: person.accountId,
    toAccountId: ngn.id,
    recipientTier: bank.tier(),
    amount,
    reference: bank.reference(),
    idempotencyKey: `request:${request.id}`,
    limits: { tier: person.tier },
    metadata: {
      txns: [
        {
          id: bank.id(),
          accountId: ngn.id,
          direction: 'credit',
          type: 'transfer_in',
          category: 'transfers',
          narration: request.note || 'Money request',
          counterparty: { name: `${person.firstName} ${person.lastName}`, nemtag: person.nemtag },
          transferId,
        },
      ],
    },
  });
  request.status = 'paid';
  request.transfer_id = transferId;
  request.responded_at = entry.createdAt;
  bank.notify({
    category: 'transactions',
    title: `${person.firstName} paid your request`,
    body: `${person.firstName} sent you the money for "${request.note || 'your request'}".`,
    deep_link: `nembank://pay/requests/${request.id}`,
  });
}

export function processRequests(bank: MockBank): boolean {
  const now = bank.nowIso();
  const cutoff = new Date(bank.now().getTime() - PAY_BACK_MS).toISOString();
  let changed = false;
  for (const request of bank.world.moneyRequests) {
    if (request.status !== 'pending') continue;
    if (request.expires_at <= now) {
      request.status = 'expired';
      changed = true;
    } else if (request.direction === 'outgoing' && request.created_at <= cutoff) {
      const person = bank.world.people.find((p) => p.userId === request.payer.user_id);
      if (person) {
        try {
          payBack(bank, request, person);
        } catch {
          // A friend who cannot pay just leaves the request pending, like a real one.
          continue;
        }
        changed = true;
      }
    }
  }
  return changed;
}

function splitView(bank: MockBank, split: Schema<'SplitBill'>): Schema<'SplitBill'> {
  for (const share of split.shares) {
    const request = bank.world.moneyRequests.find((r) => r.id === share.money_request_id);
    if (request) share.status = request.status;
  }
  const paid = split.shares.filter((s) => s.status === 'paid').map((s) => fromApi(s.amount));
  split.paid_total = api(sum(paid, split.total.currency));
  return split;
}

export function moneyRequestsRepo(bank: MockBank): MoneyRequestsRepo {
  const find = requestFinder(bank);
  const findSplit = (id: string) => {
    const s = bank.world.splitBills.find((x) => x.id === id);
    if (!s) throw notFound('Split bill');
    return s;
  };
  const createRequest = (
    person: Person,
    amount: Schema<'Money'>,
    note: string,
    days: number,
    splitId: string | null,
  ) => {
    const now = bank.now();
    const request: Schema<'MoneyRequest'> = {
      id: bank.id(),
      direction: 'outgoing',
      requester: me(bank),
      payer: partyOf(person),
      amount,
      note,
      status: 'pending',
      split_bill_id: splitId,
      transfer_id: null,
      created_at: now.toISOString(),
      expires_at: addDays(now, days).toISOString(),
      responded_at: null,
    };
    bank.world.moneyRequests.push(request);
    return request;
  };
  const participant = (nemtag: string) => {
    const person = personByNemtag(bank, nemtag);
    if (!person) throw problem(404, 'not_found', `No Nem user is @${nemtag.replace(/^@/, '')}`);
    return person;
  };

  return {
    async list({ query }) {
      const items = newestFirst(bank.world.moneyRequests).filter(
        (r) => r.direction === query.direction && (!query.status || r.status === query.status),
      );
      return paginate(items, query);
    },
    async create({ body }) {
      const person = participant(body.payer_nemtag);
      if (body.expires_in_days < 1 || body.expires_in_days > 30) {
        throw problem(422, 'validation_failed', 'Requests last 1 to 30 days');
      }
      return createRequest(
        person,
        api(positive(body.amount, 'NGN')),
        body.note?.trim() ?? '',
        body.expires_in_days,
        null,
      );
    },
    async get({ path }) {
      return find(path.request_id);
    },
    async pay({ path, body, idempotencyKey }) {
      const request = find(path.request_id);
      const record = bank.idempotent(
        idempotencyKey,
        { path, body },
        (id) => bank.world.transfers.find((t) => t.id === id),
        () => {
          if (request.direction !== 'incoming' || request.status !== 'pending') {
            throw problem(409, 'invalid_state', 'This request is no longer open');
          }
          const person = bank.world.people.find((p) => p.userId === request.requester.user_id);
          if (!person) throw notFound('Requester');
          const transfer = sendMoney(bank, {
            sourceAccountId: body.source_account_id,
            destination: { kind: 'nem', account_number: person.accountNumber },
            amount: request.amount,
            narration: request.note || `Request from ${person.firstName}`,
            paysRequestId: request.id,
          });
          request.status = 'paid';
          request.transfer_id = transfer.id;
          request.responded_at = bank.nowIso();
          return transfer;
        },
      );
      return transferView(record);
    },
    async decline({ path }) {
      const request = find(path.request_id);
      if (request.direction !== 'incoming' || request.status !== 'pending') {
        throw problem(409, 'invalid_state', 'This request is no longer open');
      }
      request.status = 'declined';
      request.responded_at = bank.nowIso();
      return request;
    },
    async cancel({ path }) {
      const request = find(path.request_id);
      if (request.direction !== 'outgoing' || request.status !== 'pending') {
        throw problem(409, 'invalid_state', 'This request is no longer open');
      }
      request.status = 'cancelled';
      request.responded_at = bank.nowIso();
      return request;
    },
    async listSplitBills({ query } = {}) {
      const page = paginate(newestFirst(bank.world.splitBills), query);
      return { data: page.data.map((s) => splitView(bank, s)), page: page.page };
    },
    async createSplitBill({ body }) {
      const total = positive(body.total, 'NGN');
      const people = body.participants.map((p) => participant(p.nemtag));
      if (people.length === 0) throw problem(422, 'validation_failed', 'Add at least one person');
      const heads = BigInt(people.length + (body.include_self ? 1 : 0));
      let amounts: bigint[];
      if (body.split === 'equal') {
        // Kobo that do not divide evenly go to the first friend, never lost.
        const share = total.amount / heads;
        const remainder = total.amount - share * heads;
        amounts = people.map((_, i) => share + (i === 0 ? remainder : 0n));
      } else {
        amounts = body.participants.map((p) => {
          if (!p.amount) throw problem(422, 'validation_failed', 'Give every person an amount');
          return positive(p.amount, 'NGN').amount;
        });
        const requested = amounts.reduce((a, b) => a + b, 0n);
        if (requested > total.amount || (!body.include_self && requested !== total.amount)) {
          throw problem(422, 'validation_failed', 'The shares must add up to the total');
        }
      }
      const id = bank.id();
      const shares: Schema<'SplitShare'>[] = people.map((person, i) => {
        const request = createRequest(person, api(money(amounts[i]!, 'NGN')), body.title, 7, id);
        return {
          participant: partyOf(person),
          amount: request.amount,
          status: 'pending',
          money_request_id: request.id,
          last_reminded_at: null,
        };
      });
      if (body.include_self) {
        const others = amounts.reduce((a, b) => a + b, 0n);
        shares.unshift({
          participant: me(bank),
          amount: api(money(total.amount - others, 'NGN')),
          status: 'paid',
          money_request_id: null,
          last_reminded_at: null,
        });
      }
      const split: Schema<'SplitBill'> = {
        id,
        title: body.title,
        total: api(total),
        split: body.split,
        shares,
        paid_total: api(money(0n, 'NGN')),
        created_at: bank.nowIso(),
      };
      bank.world.splitBills.push(split);
      return splitView(bank, split);
    },
    async getSplitBill({ path }) {
      return splitView(bank, findSplit(path.split_bill_id));
    },
    async remindSplitBill({ path }) {
      const split = splitView(bank, findSplit(path.split_bill_id));
      const now = bank.now();
      const recent = split.shares.some(
        (s) =>
          s.last_reminded_at && now.getTime() - Date.parse(s.last_reminded_at) < REMIND_EVERY_MS,
      );
      if (recent) throw problem(429, 'rate_limited', 'You reminded everyone recently');
      for (const share of split.shares) {
        if (share.status === 'pending') share.last_reminded_at = now.toISOString();
      }
    },
  };
}

const qrSignature = (body: string) => sha256Hex(`nem-mock-qr-key|${body}`).slice(0, 24);

export function paymentLinksRepo(bank: MockBank): PaymentLinksRepo {
  const find = (id: string) => {
    const link = bank.world.paymentLinks.find((l) => l.id === id);
    if (!link) throw notFound('Payment link');
    if (link.status === 'active' && link.expires_at && link.expires_at < bank.nowIso()) {
      link.status = 'expired';
    }
    return link;
  };
  return {
    async list({ query } = {}) {
      const page = paginate(newestFirst(bank.world.paymentLinks), query);
      return { data: page.data.map((l) => find(l.id)), page: page.page };
    },
    async create({ body }) {
      const account = bank.ownAccount(body.account_id);
      if (body.amount_mode === 'fixed' && !body.amount) {
        throw problem(422, 'validation_failed', 'A fixed link needs an amount');
      }
      const slug = bank.id().replaceAll('-', '').slice(-8);
      const link: Schema<'PaymentLink'> = {
        id: bank.id(),
        slug,
        url: `https://nem-bank-fodx.vercel.app/pay/${slug}`,
        account_id: account.id,
        title: body.title.trim(),
        note: body.note?.trim() || null,
        amount_mode: body.amount_mode,
        amount:
          body.amount_mode === 'fixed' && body.amount
            ? api(positive(body.amount, account.currency))
            : null,
        status: 'active',
        payments_count: 0,
        total_received: api(money(0n, account.currency)),
        expires_at: body.expires_at ?? null,
        created_at: bank.nowIso(),
      };
      bank.world.paymentLinks.push(link);
      return link;
    },
    async get({ path }) {
      return find(path.link_id);
    },
    async update({ path, body }) {
      const link = find(path.link_id);
      if (link.status === 'expired') throw problem(409, 'invalid_state', 'This link has expired');
      if (body.title !== undefined) link.title = body.title.trim();
      if (body.note !== undefined) link.note = body.note?.trim() || null;
      if (body.status) link.status = body.status;
      return link;
    },
    async getMyQr({ query }) {
      const account = bank.ownAccount(query.account_id);
      const accountNumber = bank.world.accountMeta[account.id]!.accountNumber;
      const expires = query.amount_minor
        ? addMinutes(bank.now(), QR_TTL_MINUTES).toISOString()
        : null;
      const body = ['NEMQR1', accountNumber, query.amount_minor ?? '-', expires ?? '-'].join('|');
      return {
        payload: `${body}|${qrSignature(body)}`,
        account_id: account.id,
        amount: query.amount_minor ? api(money(query.amount_minor, account.currency)) : null,
        expires_at: expires,
        key_id: QR_KEY_ID,
      };
    },
    async decodeQr({ body }) {
      const invalid = (reason: NonNullable<Schema<'DecodedQr'>['invalid_reason']>) => ({
        valid: false,
        invalid_reason: reason,
        payee: null,
        amount: null,
      });
      const parts = body.payload.split('|');
      if (parts.length !== 5 || parts[0] !== 'NEMQR1') return invalid('not_nem_qr');
      const [, accountNumber, amount, expires, signature] = parts as [
        string,
        string,
        string,
        string,
        string,
      ];
      if (qrSignature(parts.slice(0, 4).join('|')) !== signature) return invalid('bad_signature');
      if (expires !== '-' && expires < bank.nowIso()) return invalid('expired');
      const person = bank.world.people.find((p) => p.accountNumber === accountNumber);
      const ownId = Object.entries(bank.world.accountMeta).find(
        ([, m]) => m.accountNumber === accountNumber,
      )?.[0];
      if (!person && !ownId) return invalid('unknown_account');
      const name = person ? `${person.firstName} ${person.lastName}` : accountName(bank);
      return {
        valid: true,
        invalid_reason: null,
        payee: {
          kind: 'nem',
          name,
          nemtag: person?.nemtag ?? bank.user.nemtag,
          user_id: person?.userId ?? bank.user.id,
          avatar_url: null,
          bank_code: NEM_BANK.code,
          bank_name: NEM_BANK.name,
          account_number: accountNumber,
          name_match: null,
          is_saved_beneficiary: bank.world.beneficiaries.some(
            (b) => b.account_number === accountNumber,
          ),
          beneficiary_id:
            bank.world.beneficiaries.find((b) => b.account_number === accountNumber)?.id ?? null,
        },
        amount: amount === '-' ? null : api(money(amount, 'NGN')),
      };
    },
  };
}
