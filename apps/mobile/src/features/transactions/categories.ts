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
