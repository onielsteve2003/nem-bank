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
} from '@/components/icons';
import i18n from '@/lib/i18n';

export type Category = Schema<'NotificationCategory'>;
export type Channel = keyof Schema<'ChannelPreferences'>;

/** Categories in the order the preferences screen lists them (NOT-2). */
const ORDER: [Category, LucideIcon][] = [
  ['transactions', ArrowLeftRight],
  ['security', ShieldCheck],
  ['savings', PiggyBank],
  ['ajo', Handshake],
  ['credit', CreditCard],
  ['support', LifeBuoy],
  ['product', Sparkles],
  ['marketing', Megaphone],
];

export const CATEGORIES: {
  value: Category;
  readonly label: string;
  readonly hint: string;
  icon: LucideIcon;
}[] = ORDER.map(([value, icon]) => ({
  value,
  icon,
  get label() {
    return i18n.t(`notifications.categories.${value}.label`);
  },
  get hint() {
    return i18n.t(`notifications.categories.${value}.hint`);
  },
}));

export const categoryMeta = (c: Category) => CATEGORIES.find((x) => x.value === c)!;

export const CHANNELS: { value: Channel; readonly label: string }[] = (
  ['in_app', 'push', 'email'] as const
).map((value) => ({
  value,
  get label() {
    return i18n.t(`notifications.channels.${value}`);
  },
}));

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
    { title: i18n.t('notifications.groups.today'), items: [] },
    { title: i18n.t('notifications.groups.week'), items: [] },
    { title: i18n.t('notifications.groups.earlier'), items: [] },
  ];
  for (const n of items) {
    const at = Date.parse(n.created_at);
    groups[at >= today ? 0 : at >= today - 6 * DAY ? 1 : 2]!.items.push(n);
  }
  return groups.filter((g) => g.items.length > 0);
}
