import type { Schema } from '@nem/contracts';
import { formatMoney, money, type Money } from '@nem/shared';

import type { Tone } from '@/components/tone';
import i18n, { withLabel } from '@/lib/i18n';
import { fromApiMoney } from '@/lib/money';

type Group = Schema<'AjoGroup'>;
type Frequency = Schema<'AjoFrequency'>;

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 12;
export const MAX_AJO_NAME = 40;

export const FREQUENCIES = (['daily', 'weekly', 'monthly'] as const satisfies Frequency[]).map(
  (value) => withLabel(`ajo.frequencies.${value}`, { value }),
);

/** What each member takes home on their turn: everyone's contribution for one cycle. */
export const potOf = (contribution: Money, members: number): Money =>
  money(contribution.amount * BigInt(members), contribution.currency);

/** "₦10,000 a month". */
export const contributionLabel = (amount: Money, frequency: Frequency) =>
  i18n.t(`ajo.per.${frequency}`, { amount: formatMoney(amount, { trimZeroMinor: true }) });

/** "4 months": one cycle per member. */
export function durationLabel(members: number, frequency: Frequency) {
  return i18n.t(`ajo.duration.${frequency}`, { count: members });
}

/** "₦10,000 a month · 3 of 4 joined". */
export function groupSubtitle(g: Group): string {
  const amount = contributionLabel(fromApiMoney(g.contribution), g.frequency);
  if (g.status === 'forming')
    return i18n.t('ajo.subtitle.forming', {
      amount,
      joined: joinedCount(g),
      total: g.member_count,
    });
  if (g.status === 'active')
    return i18n.t('ajo.subtitle.active', {
      amount,
      turn: g.current_cycle,
      total: g.total_cycles,
    });
  return amount;
}

export const joinedCount = (g: Group) => g.members.filter((m) => m.status === 'joined').length;

export const AJO_STATUS: Record<Group['status'], { label: string; tone: Tone }> = {
  forming: withLabel('ajo.status.forming', { tone: 'warning' }),
  active: withLabel('ajo.status.active', { tone: 'primary' }),
  completed: withLabel('ajo.status.completed', { tone: 'success' }),
  cancelled: withLabel('ajo.status.cancelled', { tone: 'neutral' }),
};

/** The text sent with an invite link. */
export const inviteMessage = (g: Group, url: string) =>
  i18n.t('ajo.inviteMessage', {
    name: g.name,
    contribution: contributionLabel(fromApiMoney(g.contribution), g.frequency),
    count: g.member_count,
    url,
  });

type Cycle = Schema<'AjoCycle'>;
type Member = Group['members'][number];

export const PAYOUT_STATUS: Record<Cycle['payout_status'], { label: string; tone: Tone }> = {
  upcoming: withLabel('ajo.payout.upcoming', { tone: 'neutral' }),
  collecting: withLabel('ajo.payout.collecting', { tone: 'primary' }),
  paid: withLabel('ajo.payout.paid', { tone: 'success' }),
  short_paid: withLabel('ajo.payout.short_paid', { tone: 'warning' }),
};

export const CONTRIBUTION_STATUS: Record<
  Schema<'AjoContribution'>['status'],
  { label: string; tone: Tone }
> = {
  pending: withLabel('ajo.contribution.pending', { tone: 'neutral' }),
  paid: withLabel('ajo.contribution.paid', { tone: 'success' }),
  late: withLabel('ajo.contribution.late', { tone: 'warning' }),
  defaulted: withLabel('ajo.contribution.defaulted', { tone: 'danger' }),
};

export const paidCount = (c: Cycle) => c.contributions.filter((x) => x.status === 'paid').length;

/**
 * The default flag every member sees (AJO-5). A defaulter who has already had
 * their payout owes the ajo, which is the case that matters most.
 */
export function defaultFlag(m: Member): { label: string; tone: Tone } | null {
  if (m.status !== 'defaulted' && m.missed_contributions === 0) return null;
  if (m.has_received_payout) return { label: i18n.t('ajo.flag.owes'), tone: 'danger' };
  return {
    label: i18n.t('ajo.flag.missed', { count: Math.max(m.missed_contributions, 1) }),
    tone: 'warning',
  };
}
