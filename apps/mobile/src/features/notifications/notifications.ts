import type { Schema } from '@nem/contracts';
import {
  ArrowLeftRight,
  CreditCard,
  Handshake,
  LifeBuoy,
  Megaphone,
  PiggyBank,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from 'lucide-react-native';

export type Category = Schema<'NotificationCategory'>;
export type Channel = keyof Schema<'ChannelPreferences'>;

/** Categories in the order the preferences screen lists them (NOT-2). */
export const CATEGORIES: { value: Category; label: string; hint: string; icon: LucideIcon }[] = [
  {
    value: 'transactions',
    label: 'Payments',
    hint: 'Money in and out, transfers and bills',
    icon: ArrowLeftRight,
  },
  {
    value: 'security',
    label: 'Security',
    hint: 'Sign-ins, new devices and anything unusual',
    icon: ShieldCheck,
  },
  { value: 'savings', label: 'Savings', hint: 'Goals, locks and interest', icon: PiggyBank },
  { value: 'ajo', label: 'Ajo', hint: 'Contributions and payouts', icon: Handshake },
  {
    value: 'credit',
    label: 'Credit',
    hint: 'Repayments and offers you asked for',
    icon: CreditCard,
  },
  { value: 'support', label: 'Support', hint: 'Replies from our team', icon: LifeBuoy },
  { value: 'product', label: 'Product news', hint: 'New features in Nem', icon: Sparkles },
  {
    value: 'marketing',
    label: 'Offers',
    hint: 'Promotions from Nem and partners',
    icon: Megaphone,
  },
];

export const categoryMeta = (c: Category) => CATEGORIES.find((x) => x.value === c)!;

export const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'in_app', label: 'In the app' },
  { value: 'push', label: 'Push' },
  { value: 'email', label: 'Email' },
];

/** Security alerts always reach the inbox; only their push and email can go off. */
export const isLocked = (category: Category, channel: Channel) =>
  category === 'security' && channel === 'in_app';

/** Turns one channel of one category on or off, never the locked one. */
export function setChannel(
  prefs: Schema<'NotificationPreferences'>,
  category: Category,
  channel: Channel,
  on: boolean,
): Schema<'NotificationPreferences'> {
  if (isLocked(category, channel)) return prefs;
  return {
    categories: {
      ...prefs.categories,
      [category]: { ...prefs.categories[category], [channel]: on },
    },
  };
}

export type Group = { title: string; items: Schema<'Notification'>[] };

const DAY = 24 * 60 * 60 * 1000;
/** Midnight in Lagos (UTC+1), as a timestamp. */
const lagosDayStart = (t: number) => Math.floor((t + 3_600_000) / DAY) * DAY - 3_600_000;

/** Today, this week and earlier, on the Lagos clock. Input is newest first. */
export function groupByDay(items: Schema<'Notification'>[], now = Date.now()): Group[] {
  const today = lagosDayStart(now);
  const groups: Group[] = [
    { title: 'Today', items: [] },
    { title: 'This week', items: [] },
    { title: 'Earlier', items: [] },
  ];
  for (const n of items) {
    const at = Date.parse(n.created_at);
    groups[at >= today ? 0 : at >= today - 6 * DAY ? 1 : 2]!.items.push(n);
  }
  return groups.filter((g) => g.items.length > 0);
}
