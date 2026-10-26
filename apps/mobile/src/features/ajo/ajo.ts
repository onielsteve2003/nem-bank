import type { Schema } from '@nem/contracts';
import { formatMoney, money, type Money } from '@nem/shared';

import type { Tone } from '@/components/tone';
import { fromApiMoney } from '@/lib/money';

type Group = Schema<'AjoGroup'>;
type Frequency = Schema<'AjoFrequency'>;

export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 12;
export const MAX_AJO_NAME = 40;

export const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const PER: Record<Frequency, string> = { daily: 'a day', weekly: 'a week', monthly: 'a month' };
const UNIT: Record<Frequency, [string, string]> = {
  daily: ['day', 'days'],
  weekly: ['week', 'weeks'],
  monthly: ['month', 'months'],
};

/** What each member takes home on their turn: everyone's contribution for one cycle. */
export const potOf = (contribution: Money, members: number): Money =>
  money(contribution.amount * BigInt(members), contribution.currency);

/** "₦10,000 a month". */
export const contributionLabel = (amount: Money, frequency: Frequency) =>
  `${formatMoney(amount, { trimZeroMinor: true })} ${PER[frequency]}`;

/** "4 months": one cycle per member. */
export function durationLabel(members: number, frequency: Frequency) {
  const [one, many] = UNIT[frequency];
  return `${members} ${members === 1 ? one : many}`;
}

/** "₦10,000 a month · 3 of 4 joined". */
export function groupSubtitle(g: Group): string {
  const amount = contributionLabel(fromApiMoney(g.contribution), g.frequency);
  if (g.status === 'forming') return `${amount} · ${joinedCount(g)} of ${g.member_count} joined`;
  if (g.status === 'active') return `${amount} · turn ${g.current_cycle} of ${g.total_cycles}`;
  return amount;
}

export const joinedCount = (g: Group) => g.members.filter((m) => m.status === 'joined').length;

export const AJO_STATUS: Record<Group['status'], { label: string; tone: Tone }> = {
  forming: { label: 'Forming', tone: 'warning' },
  active: { label: 'Active', tone: 'primary' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** The text sent with an invite link. */
export const inviteMessage = (g: Group, url: string) =>
  `Join my ajo "${g.name}" on Nem: ${contributionLabel(fromApiMoney(g.contribution), g.frequency)}, ${g.member_count} people, everyone takes the pot once. ${url}`;
