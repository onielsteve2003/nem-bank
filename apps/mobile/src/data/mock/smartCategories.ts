import type { Schema } from '@nem/contracts';

import type { TransactionMeta } from './bank';
import type { MockBank } from './runtime';

type Picked = Pick<Schema<'Transaction'>, 'category' | 'category_source' | 'category_confidence'>;

/** Merchants the model has seen often enough to be very sure about. */
const WELL_KNOWN = new Set([
  'bolt',
  'uber',
  'netflix',
  'spotify',
  'chicken republic',
  "domino's pizza",
  'shoprite lekki',
  'spar ikeja city mall',
]);

/** How rules and corrections key a merchant: case and spacing never split one merchant in two. */
export function merchantKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A stable 0–1 value per name, so the same merchant always gets the same confidence. */
function unit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 0xffffffff;
}

/**
 * The category a transaction shows (AI-3), most specific first: the customer's
 * own correction of this payment, their "always" rule for the merchant, the
 * model's guess for card payments (when smart categories is on), then rules.
 * Stand-in for the TF-IDF model the Go service will score (Phase 2).
 */
export function smartCategory(bank: MockBank, meta: TransactionMeta): Picked {
  const own = bank.world.categoryOverrides[meta.id];
  if (own) return { category: own, category_source: 'user', category_confidence: null };
  const key = merchantKey(meta.counterparty.name);
  const rule = bank.world.merchantCategories?.[key];
  if (rule) return { category: rule, category_source: 'user', category_confidence: null };
  if (meta.type === 'card_payment' && bank.world.preferences.ai.smart_categories) {
    const confidence = WELL_KNOWN.has(key) ? 0.9 + unit(key) * 0.08 : 0.5 + unit(key) * 0.35;
    return {
      category: meta.category,
      category_source: 'model',
      category_confidence: Math.round(confidence * 100) / 100,
    };
  }
  return { category: meta.category, category_source: 'rules', category_confidence: null };
}
