import type { Schema } from '@nem/contracts';
import { Lightbulb, Smartphone, Tv, Wifi, type LucideIcon } from 'lucide-react-native';

// Bills (FR-BILL): the four kinds of bill and how each is named and drawn.

export type BillCategory = Schema<'BillCategory'>;

export const BILL_CATEGORIES: {
  value: BillCategory;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  { value: 'airtime', label: 'Airtime', description: 'Top up any network', icon: Smartphone },
  { value: 'data', label: 'Data', description: 'Bundles for every network', icon: Wifi },
  {
    value: 'electricity',
    label: 'Electricity',
    description: 'Prepaid meter tokens',
    icon: Lightbulb,
  },
  { value: 'cable_tv', label: 'Cable TV', description: 'DStv, GOtv, StarTimes', icon: Tv },
];

export const categoryMeta = (category: BillCategory) =>
  BILL_CATEGORIES.find((c) => c.value === category)!;

export const isBillCategory = (value: unknown): value is BillCategory =>
  BILL_CATEGORIES.some((c) => c.value === value);

/** What the customer ID on a bill is called for its kind. */
export const CUSTOMER_LABEL: Record<BillCategory, string> = {
  airtime: 'Phone number',
  data: 'Phone number',
  electricity: 'Meter number',
  cable_tv: 'Smartcard number',
};

/** "26 Oct", in Lagos time. */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });

export type MobileNetwork = Schema<'MobileNetwork'>;

export const NETWORKS: { value: MobileNetwork; label: string }[] = [
  { value: 'mtn', label: 'MTN' },
  { value: 'airtel', label: 'Airtel' },
  { value: 'glo', label: 'Glo' },
  { value: 'nine_mobile', label: '9mobile' },
];

/** "+2348031234567" or "0803 123 4567" → "08031234567". */
export function localPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  return digits.startsWith('234') ? `0${digits.slice(3)}` : digits;
}

/** An 11-digit Nigerian mobile number, 070… to 091…. */
export const isMobileNumber = (local: string) => /^0[789][01]\d{8}$/.test(local);

/** "08031234567" → "+2348031234567". */
export const toE164 = (local: string) => `+234${local.slice(1)}`;

/** The biller for a network's airtime or data, e.g. "mtn-data". */
export const topUpBillerId = (network: MobileNetwork, category: 'airtime' | 'data') =>
  `${network}-${category}`;

/** Quick airtime amounts, in naira. */
export const AIRTIME_PRESETS = [100, 200, 500, 1_000, 2_000, 5_000] as const;

/** "nine_mobile-data" → "nine_mobile"; null for billers that are not a network's. */
export function networkOfBiller(billerId: string): MobileNetwork | null {
  const network = billerId.slice(0, billerId.lastIndexOf('-'));
  return NETWORKS.some((n) => n.value === network) ? (network as MobileNetwork) : null;
}

/** A saved biller opened from the hub: its provider and number, filled in. */
export interface BillPrefill {
  billerId?: string;
  customerId?: string;
}

type Schedule = Schema<'BillSchedule'>;

export const isLiveSchedule = (s: Schedule) => s.status === 'active' || s.status === 'paused';

/** Live schedules first (soonest next), then ended ones newest first. */
export function sortBillSchedules(list: Schedule[]): Schedule[] {
  const rank = (s: Schedule) => (isLiveSchedule(s) ? 0 : 1);
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (isLiveSchedule(a)
        ? (a.next_run_at ?? '9').localeCompare(b.next_run_at ?? '9')
        : b.created_at.localeCompare(a.created_at)),
  );
}
