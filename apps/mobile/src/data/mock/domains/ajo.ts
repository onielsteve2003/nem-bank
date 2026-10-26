import type { Schema } from '@nem/contracts';
import { formatMoney, money, negate } from '@nem/shared';

import { isApiError, problem } from '../../errors';
import type { AjoRepo } from '../../repositories';
import { addDays, api, fromApi, newestFirst, notFound, positive } from '../convert';
import type { MockBank } from '../runtime';
import { me, partyOf, personByNemtag } from '../views';
import type { AjoRecord } from '../world';

// Ajo / esusu (AJO-1..5): members pay into an escrow account each cycle and one
// member takes the whole pot, in turn. Escrow is a ledger account, so the pot is
// always exactly what was paid in.

const INVITE_TTL_DAYS = 7;
const CYCLE_DAYS: Record<Schema<'AjoFrequency'>, number> = { daily: 1, weekly: 7, monthly: 30 };

function memberAccount(bank: MockBank, group: AjoRecord, userId: string): string | null {
  if (userId === bank.user.id) return group.sourceAccountId;
  return bank.world.people.find((p) => p.userId === userId)?.accountId ?? null;
}

export function ajoView(bank: MockBank, group: AjoRecord): Schema<'AjoGroup'> {
  const { escrowAccountId, sourceAccountId: _s, inviteCode: _i, cycles: _c, ...rest } = group;
  return { ...rest, pot_balance: api(bank.ledger.account(escrowAccountId).balance) };
}

/**
 * Collects every unpaid contribution for a cycle; a member who cannot pay is
 * marked late (and told once). Returns how much reached the escrow.
 */
function collect(bank: MockBank, group: AjoRecord, cycle: Schema<'AjoCycle'>): bigint {
  const amount = fromApi(group.contribution);
  let collected = 0n;
  for (const c of cycle.contributions) {
    if (c.status === 'paid') continue;
    const from = memberAccount(bank, group, c.member.user_id);
    if (!from) continue;
    c.attempts += 1;
    try {
      const mine = c.member.user_id === bank.user.id;
      bank.ledger.post({
        kind: 'ajo_contribution',
        reference: bank.reference('AJO'),
        idempotencyKey: `ajo:${group.id}:${cycle.number}:${c.member.user_id}`,
        postings: [
          { accountId: from, amount: negate(amount) },
          { accountId: group.escrowAccountId, amount },
        ],
        metadata: mine
          ? {
              txns: [
                {
                  id: bank.id(),
                  accountId: from,
                  direction: 'debit',
                  type: 'ajo',
                  category: 'savings',
                  narration: `${group.name} contribution`,
                  counterparty: { name: group.name },
                },
              ],
            }
          : {},
      });
      c.status = 'paid';
      c.paid_at = bank.nowIso();
      collected += amount.amount;
      const member = group.members.find((m) => m.member.user_id === c.member.user_id);
      if (member) member.contributions_paid += 1;
    } catch (error) {
      if (!isApiError(error)) throw error;
      const firstMiss = c.status === 'pending';
      c.status = 'late';
      if (firstMiss && c.member.user_id === bank.user.id) {
        bank.notify({
          category: 'ajo',
          title: `${group.name}: contribution missed`,
          body: `Add money to pay your contribution within ${group.grace_period_hours} hours.`,
          deep_link: `nembank://grow/ajo/${group.id}`,
        });
      }
    }
  }
  return collected;
}

function payout(bank: MockBank, group: AjoRecord, cycle: Schema<'AjoCycle'>) {
  const to = memberAccount(bank, group, cycle.payout_to.user_id);
  const pot = bank.ledger.account(group.escrowAccountId).balance;
  if (!to || pot.amount <= 0n) return;
  const mine = cycle.payout_to.user_id === bank.user.id;
  bank.ledger.post({
    kind: 'ajo_payout',
    reference: bank.reference('AJO'),
    idempotencyKey: `ajo-payout:${group.id}:${cycle.number}`,
    postings: [
      { accountId: group.escrowAccountId, amount: negate(pot) },
      { accountId: to, amount: pot },
    ],
    metadata: mine
      ? {
          txns: [
            {
              id: bank.id(),
              accountId: to,
              direction: 'credit',
              type: 'ajo',
              category: 'savings',
              narration: `${group.name} payout`,
              counterparty: { name: group.name },
            },
          ],
        }
      : {},
  });
  cycle.payout_status = pot.amount < fromApi(cycle.payout_amount).amount ? 'short_paid' : 'paid';
  const member = group.members.find((m) => m.member.user_id === cycle.payout_to.user_id);
  if (member) member.has_received_payout = true;
  bank.notify({
    category: 'ajo',
    title: mine
      ? `Your ${group.name} payout arrived`
      : `${group.name} paid ${cycle.payout_to.name}`,
    body: `Cycle ${cycle.number} of ${group.total_cycles} is done.`,
    deep_link: `nembank://grow/ajo/${group.id}`,
  });
}

/**
 * AJO-5: a late contribution is retried once more when the grace period ends.
 * Money that arrives goes straight on to that cycle's payee; anyone still
 * unpaid is flagged as a defaulter for every member to see.
 */
function settleLate(bank: MockBank, group: AjoRecord, now: string): boolean {
  let changed = false;
  for (const cycle of group.cycles) {
    if (cycle.number >= group.current_cycle) continue;
    if (!cycle.contributions.some((c) => c.status === 'late')) continue;
    const graceEnds = new Date(
      new Date(cycle.due_at).getTime() + group.grace_period_hours * 3_600_000,
    ).toISOString();
    if (graceEnds > now) continue;
    const late = collect(bank, group, cycle);
    const to = memberAccount(bank, group, cycle.payout_to.user_id);
    if (late > 0n && to) {
      const amount = money(late, 'NGN');
      bank.ledger.post({
        kind: 'ajo_payout',
        reference: bank.reference('AJO'),
        idempotencyKey: `ajo-late:${group.id}:${cycle.number}:${bank.id()}`,
        postings: [
          { accountId: group.escrowAccountId, amount: negate(amount) },
          { accountId: to, amount },
        ],
      });
    }
    for (const c of cycle.contributions) {
      if (c.status !== 'late') continue;
      c.status = 'defaulted';
      const m = group.members.find((x) => x.member.user_id === c.member.user_id);
      if (!m) continue;
      m.missed_contributions += 1;
      m.status = 'defaulted';
      if (m.member.user_id === bank.user.id) {
        bank.notify({
          category: 'ajo',
          title: `${group.name}: you are marked as a defaulter`,
          body: `Your ${formatMoney(fromApi(group.contribution), { trimZeroMinor: true })} for turn ${cycle.number} was not paid within ${group.grace_period_hours} hours. Everyone in the ajo can see the flag.`,
          deep_link: `nembank://grow/ajo/${group.id}`,
        });
      }
    }
    if (cycle.contributions.every((c) => c.status === 'paid')) cycle.payout_status = 'paid';
    changed = true;
  }
  return changed;
}

function refreshNext(group: AjoRecord) {
  const next = group.cycles.find((c) => c.number === group.current_cycle);
  group.next_payout = next
    ? { member: next.payout_to, amount: next.payout_amount, at: next.due_at }
    : null;
  group.next_contribution_at = next?.due_at ?? null;
}

export function processAjo(bank: MockBank): boolean {
  const now = bank.nowIso();
  let changed = false;
  for (const group of bank.world.ajo) {
    if (group.status === 'completed') changed = settleLate(bank, group, now) || changed;
    if (group.status !== 'active') continue;
    let cycle = group.cycles.find((c) => c.number === group.current_cycle);
    while (cycle && cycle.due_at <= now) {
      collect(bank, group, cycle);
      payout(bank, group, cycle);
      group.current_cycle += 1;
      changed = true;
      cycle = group.cycles.find((c) => c.number === group.current_cycle);
      if (!cycle) {
        group.status = 'completed';
        break;
      }
      cycle.payout_status = 'collecting';
      collect(bank, group, cycle);
    }
    changed = settleLate(bank, group, now) || changed;
    refreshNext(group);
  }
  return changed;
}

const potOf = (contribution: Schema<'Money'>, members: number) =>
  api(money(fromApi(contribution).amount * BigInt(members), contribution.currency));

export function ajoRepo(bank: MockBank): AjoRepo {
  const find = (id: string) => {
    const g = bank.world.ajo.find((x) => x.id === id);
    if (!g) throw notFound('Ajo group');
    return g;
  };
  const byCode = (code: string) => {
    const g = bank.world.ajo.find((x) => x.inviteCode === code.toUpperCase());
    if (!g) throw problem(404, 'not_found', 'This invite link is not valid');
    return g;
  };
  const isMine = (g: AjoRecord) => g.created_by.user_id === bank.user.id;
  const isMember = (g: AjoRecord) =>
    g.members.some((m) => m.member.user_id === bank.user.id && m.status !== 'left');
  // AJO-5: a defaulter who has already taken a payout is barred from new ajo.
  const assertNoDebt = () => {
    const owed = bank.world.ajo.find((g) =>
      g.members.some(
        (m) =>
          m.member.user_id === bank.user.id && m.status === 'defaulted' && m.has_received_payout,
      ),
    );
    if (owed) {
      throw problem(409, 'ajo_debt', `Pay what you owe ${owed.name} first`, {
        detail: 'You had your payout but missed a contribution after it.',
      });
    }
  };

  return {
    async listGroups() {
      // Only the customer's own groups: a friend's ajo shows up once they join it.
      const mine = bank.world.ajo.filter((g) => isMine(g) || isMember(g));
      return { data: newestFirst(mine).map((g) => ajoView(bank, g)) };
    },
    async createGroup({ body, idempotencyKey }) {
      const group = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.ajo.find((g) => g.id === id),
        () => {
          assertNoDebt();
          const contribution = positive(body.contribution, 'NGN');
          const source = bank.ownAccount(body.source_account_id);
          if (body.member_count < 2 || body.member_count > 12) {
            throw problem(422, 'validation_failed', 'An ajo has 2 to 12 members');
          }
          if (body.start_date < bank.nowIso().slice(0, 10)) {
            throw problem(422, 'validation_failed', 'Pick a start date from today');
          }
          const id = bank.id();
          const code = id.replaceAll('-', '').slice(-6).toUpperCase();
          const g: AjoRecord = {
            id,
            escrowAccountId: bank.ledger.openAccount({
              ownerType: 'system',
              ownerId: id,
              kind: 'ajo_escrow',
              currency: 'NGN',
            }).id,
            sourceAccountId: source.id,
            inviteCode: code,
            name: body.name.trim(),
            contribution: api(contribution),
            frequency: body.frequency,
            member_count: body.member_count,
            rotation: body.rotation,
            status: 'forming',
            members: [
              {
                member: me(bank),
                position: body.rotation === 'fixed' ? 1 : null,
                status: 'joined',
                has_received_payout: false,
                contributions_paid: 0,
                missed_contributions: 0,
              },
            ],
            current_cycle: 0,
            total_cycles: body.member_count,
            next_contribution_at: new Date(`${body.start_date}T09:00:00+01:00`).toISOString(),
            next_payout: null,
            grace_period_hours: body.grace_period_hours,
            invite_url: `https://nem-bank-fodx.vercel.app/ajo/${code}`,
            created_by: me(bank),
            created_at: bank.nowIso(),
            cycles: [],
          };
          bank.world.ajo.push(g);
          return g;
        },
      );
      return ajoView(bank, group);
    },
    async getGroup({ path }) {
      return ajoView(bank, find(path.group_id));
    },
    async invite({ path, body }) {
      const g = find(path.group_id);
      if (g.status !== 'forming')
        throw problem(409, 'invalid_state', 'This ajo has already started');
      const invited = (body.nemtags ?? []).map((tag) => {
        const person = personByNemtag(bank, tag);
        if (!person) throw problem(404, 'not_found', `No Nem user is @${tag.replace(/^@/, '')}`);
        return person;
      });
      for (const person of invited) {
        if (g.members.some((m) => m.member.user_id === person.userId)) continue;
        if (g.members.length >= g.member_count) throw problem(409, 'group_full', 'The ajo is full');
        // Demo friends accept straight away, so a new ajo can be started in one sitting.
        g.members.push({
          member: partyOf(person),
          position: g.rotation === 'fixed' ? g.members.length + 1 : null,
          status: 'joined',
          has_received_payout: false,
          contributions_paid: 0,
          missed_contributions: 0,
        });
      }
      return {
        invite_code: g.inviteCode,
        invite_url: g.invite_url ?? `https://nem-bank-fodx.vercel.app/ajo/${g.inviteCode}`,
        expires_at: addDays(bank.now(), INVITE_TTL_DAYS).toISOString(),
        invited: invited.map(partyOf),
      };
    },
    async getInvite({ path }) {
      return ajoView(bank, byCode(path.invite_code));
    },
    async acceptInvite({ path, body, idempotencyKey }) {
      const g = byCode(path.invite_code);
      const joined = bank.idempotent(
        idempotencyKey,
        body,
        (id) => bank.world.ajo.find((x) => x.id === id),
        () => {
          assertNoDebt();
          const source = bank.ownAccount(body.source_account_id);
          if (source.currency !== 'NGN')
            throw problem(422, 'validation_failed', 'Ajo is paid from your naira account');
          if (isMember(g)) throw problem(409, 'already_member', 'You are already in this ajo');
          if (g.status !== 'forming')
            throw problem(409, 'invalid_state', 'This ajo has already started');
          if (g.members.filter((m) => m.status === 'joined').length >= g.member_count)
            throw problem(409, 'group_full', 'This ajo is full');
          g.sourceAccountId = source.id;
          g.members.push({
            member: me(bank),
            position: g.rotation === 'fixed' ? g.members.length + 1 : null,
            status: 'joined',
            has_received_payout: false,
            contributions_paid: 0,
            missed_contributions: 0,
          });
          bank.notify({
            category: 'ajo',
            title: `You joined ${g.name}`,
            body: `${g.created_by.name} will start it once everyone is in.`,
            deep_link: `nembank://grow/ajo/${g.id}`,
          });
          return g;
        },
      );
      return ajoView(bank, joined);
    },
    async start({ path }) {
      const g = find(path.group_id);
      if (!isMine(g)) throw problem(403, 'forbidden', 'Only the organiser can start the ajo');
      if (g.status !== 'forming')
        throw problem(409, 'invalid_state', 'This ajo has already started');
      const joined = g.members.filter((m) => m.status === 'joined');
      if (joined.length !== g.member_count) {
        throw problem(
          409,
          'invalid_state',
          `Waiting for ${g.member_count - joined.length} more member(s)`,
        );
      }
      const order = [...joined];
      if (g.rotation === 'random_draw') {
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
      }
      order.forEach((m, i) => (m.position = i + 1));
      const pot = potOf(g.contribution, g.member_count);
      const step = CYCLE_DAYS[g.frequency];
      g.cycles = order.map((m, i) => ({
        number: i + 1,
        due_at: addDays(bank.now(), step * (i + 1)).toISOString(),
        payout_to: m.member,
        payout_amount: pot,
        payout_status: i === 0 ? 'collecting' : 'upcoming',
        contributions: order.map((x) => ({
          member: x.member,
          status: 'pending',
          paid_at: null,
          attempts: 0,
        })),
      }));
      g.members = order;
      g.status = 'active';
      g.current_cycle = 1;
      collect(bank, g, g.cycles[0]!);
      refreshNext(g);
      return ajoView(bank, g);
    },
    async leave({ path }) {
      const g = find(path.group_id);
      if (g.status !== 'forming') {
        throw problem(409, 'invalid_state', 'You cannot leave an ajo that has started', {
          detail: 'Members depend on every contribution. Talk to the organiser instead.',
        });
      }
      if (isMine(g)) {
        g.status = 'cancelled';
        return;
      }
      g.members = g.members.filter((m) => m.member.user_id !== bank.user.id);
    },
    async listCycles({ path }) {
      return { data: find(path.group_id).cycles };
    },
  };
}
