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
