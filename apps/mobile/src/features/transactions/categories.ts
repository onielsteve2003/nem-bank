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
} from '@/components/icons';
import i18n from '@/lib/i18n';

export type Category = Schema<'Category'>;

const ICONS: Record<Category, LucideIcon> = {
  food: Utensils,
  groceries: ShoppingCart,
  transport: Bus,
  airtime_data: Smartphone,
  bills_utilities: Lightbulb,
  shopping: ShoppingBag,
  entertainment: Clapperboard,
  subscriptions: Repeat,
  health: HeartPulse,
  education: BookOpen,
  rent_housing: Home,
  family: Users,
  transfers: ArrowLeftRight,
  salary_income: Briefcase,
  savings: PiggyBank,
  fees_charges: Receipt,
  cash: Banknote,
  other: Wallet,
};

/** What each spending category is called and drawn as, everywhere in the app. */
export const CATEGORIES = Object.fromEntries(
  (Object.keys(ICONS) as Category[]).map((category) => [
    category,
    {
      icon: ICONS[category],
      // Read on use, so the name follows the current language.
      get label() {
        return i18n.t(`categories.${category}`);
      },
    },
  ]),
) as Readonly<Record<Category, { readonly label: string; icon: LucideIcon }>>;

type Categorised = Pick<Schema<'Transaction'>, 'category_source' | 'category_confidence'>;

/** Below this, a smart guess asks the customer to check it (AI-3). */
export const UNSURE_BELOW = 0.65;

/** How sure smart categories is, in words first and a number second. */
export function confidenceText(confidence: number): string {
  const words = i18n.t(
    confidence >= 0.85
      ? 'transactions.confidence.very'
      : confidence >= UNSURE_BELOW
        ? 'transactions.confidence.fairly'
        : 'transactions.confidence.not',
  );
  return i18n.t('transactions.confidence.value', { words, pct: Math.round(confidence * 100) });
}

/** Who set a transaction's category, as the transaction screen says it. */
export function categorySourceText(t: Categorised): string {
  if (t.category_source === 'user') return i18n.t('transactions.source.user');
  if (t.category_source === 'model' && t.category_confidence != null) {
    return i18n.t('transactions.source.smartWith', {
      confidence: confidenceText(t.category_confidence),
    });
  }
  return i18n.t(
    t.category_source === 'model' ? 'transactions.source.smart' : 'transactions.source.merchant',
  );
}

/** A smart guess the model is not sure about, worth asking the customer to confirm. */
export function isUnsure(t: Categorised): boolean {
  return (
    t.category_source === 'model' &&
    t.category_confidence != null &&
    t.category_confidence < UNSURE_BELOW
  );
}
