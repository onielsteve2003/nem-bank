import type { Schema } from '@nem/contracts';
import {
  ArrowLeftRight,
  Banknote,
  BookOpen,
  Briefcase,
  Bus,
  Clapperboard,
  HeartPulse,
  Home,
  Lightbulb,
  PiggyBank,
  Receipt,
  Repeat,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Users,
  Utensils,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';

export type Category = Schema<'Category'>;

/** What each spending category is called and drawn as, everywhere in the app. */
export const CATEGORIES: Readonly<Record<Category, { label: string; icon: LucideIcon }>> = {
  food: { label: 'Food & drink', icon: Utensils },
  groceries: { label: 'Groceries', icon: ShoppingCart },
  transport: { label: 'Transport', icon: Bus },
  airtime_data: { label: 'Airtime & data', icon: Smartphone },
  bills_utilities: { label: 'Bills & utilities', icon: Lightbulb },
  shopping: { label: 'Shopping', icon: ShoppingBag },
  entertainment: { label: 'Entertainment', icon: Clapperboard },
  subscriptions: { label: 'Subscriptions', icon: Repeat },
  health: { label: 'Health', icon: HeartPulse },
  education: { label: 'Education', icon: BookOpen },
  rent_housing: { label: 'Rent & housing', icon: Home },
  family: { label: 'Family', icon: Users },
  transfers: { label: 'Transfers', icon: ArrowLeftRight },
  salary_income: { label: 'Salary & income', icon: Briefcase },
  savings: { label: 'Savings', icon: PiggyBank },
  fees_charges: { label: 'Fees & charges', icon: Receipt },
  cash: { label: 'Cash', icon: Banknote },
  other: { label: 'Other', icon: Wallet },
};

type Categorised = Pick<Schema<'Transaction'>, 'category_source' | 'category_confidence'>;

/** Below this, a smart guess asks the customer to check it (AI-3). */
export const UNSURE_BELOW = 0.65;

/** How sure smart categories is, in words first and a number second. */
export function confidenceText(confidence: number): string {
  const words =
    confidence >= 0.85 ? 'Very sure' : confidence >= UNSURE_BELOW ? 'Fairly sure' : 'Not sure';
  return `${words} (${Math.round(confidence * 100)}%)`;
}

/** Who set a transaction's category, as the transaction screen says it. */
export function categorySourceText(t: Categorised): string {
  if (t.category_source === 'user') return 'Set by you';
  if (t.category_source === 'model' && t.category_confidence != null) {
    return `Smart guess · ${confidenceText(t.category_confidence)}`;
  }
  return t.category_source === 'model' ? 'Smart guess' : 'From the merchant list';
}

/** A smart guess the model is not sure about, worth asking the customer to confirm. */
export function isUnsure(t: Categorised): boolean {
  return (
    t.category_source === 'model' &&
    t.category_confidence != null &&
    t.category_confidence < UNSURE_BELOW
  );
}
