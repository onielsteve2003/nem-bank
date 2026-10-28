import { compare, zero, type CurrencyCode, type Money } from '@nem/shared';

import { naira } from '../convert';
import type { MockBank } from '../runtime';
import type { World } from '../world';

/**
 * Duress mode (SEC-5). Unlocking with the duress PIN looks like a normal
 * unlock, but the bank then shows a decoy low balance, accepts transfers
 * without moving any money, and raises an alert only staff can see. The
 * customer's own PIN ends it. Nothing the app receives says which PIN was used.
 */
export const DECOY_NGN_BALANCE = naira(3_850);
/** Activity in the decoy view: only small amounts, so it matches the low balance. */
export const DECOY_MAX_TRANSACTION = naira(10_000);

type Duress = NonNullable<World['duress']>;

function state(bank: MockBank): Duress {
  return (bank.world.duress ??= { active: false, triggeredAt: null, alerts: [] });
}

export const inDuress = (bank: MockBank) => bank.world.duress?.active === true;

/** The duress PIN was entered: switch to the decoy and log a silent alert for staff. */
export function startDuress(bank: MockBank) {
  const d = state(bank);
  const at = bank.nowIso();
  if (!d.active) Object.assign(d, { active: true, triggeredAt: at });
  d.alerts.push(at);
}

/**
 * The real PIN was entered, so the customer is safe again. Transfers made in
 * duress never moved money; they now show as stopped.
 */
export function endDuress(bank: MockBank) {
  const d = bank.world.duress;
  if (!d?.active) return;
  Object.assign(d, { active: false, triggeredAt: null });
  const at = bank.nowIso();
  for (const t of bank.world.transfers) {
    if (!t.duressBlocked || t.status !== 'processing') continue;
    t.status = 'failed';
    t.updated_at = at;
    t.timeline.push({
      status: 'failed',
      label: 'Stopped by Nem',
      at,
      detail: 'Sent while your duress PIN was in use. No money left your account.',
    });
  }
}

/** What the decoy shows for a wallet: a small naira balance and empty foreign wallets. */
export function decoyBalance(currency: CurrencyCode, real: Money): Money {
  if (currency !== 'NGN') return zero(currency);
  return compare(real, DECOY_NGN_BALANCE) < 0 ? real : DECOY_NGN_BALANCE;
}
