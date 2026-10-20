import type { Schema } from '@nem/contracts';

import type { RiskReason } from '@/components';
import { isApiError, type ApiError } from '@/data';

type Transfer = Schema<'Transfer'>;

/**
 * What the customer is told after confirming (TRF-6): the risk engine either lets
 * it through, asks them to prove it is them, delays it (new beneficiary) or holds
 * it for a person to check.
 */
export type Outcome = 'sent' | 'processing' | 'step_up' | 'delayed' | 'held' | 'stopped';

export function outcomeOf(status: Schema<'TransferStatus'>): Outcome {
  switch (status) {
    case 'completed':
      return 'sent';
    case 'pending_step_up':
      return 'step_up';
    case 'delayed':
      return 'delayed';
    case 'held_for_review':
      return 'held';
    case 'failed':
    case 'reversed':
    case 'rejected':
    case 'cancelled':
      return 'stopped';
    default:
      return 'processing';
  }
}

/** Only waiting transfers can be called back; the hold is released (contract). */
export const canCancel = (status: Schema<'TransferStatus'>) =>
  status === 'pending_step_up' || status === 'delayed' || status === 'held_for_review';

/** The bank's plain-language reasons, in the shape RiskReasonList shows. */
export const riskReasonsOf = (transfer: Transfer): RiskReason[] =>
  (transfer.risk?.reasons ?? []).map((r) => ({
    code: r.code,
    label: r.message,
    severity: r.severity,
  }));

export interface SendError {
  message: string;
  /** The amount screen's quote is out of date: price it again before confirming. */
  requote: boolean;
}

/**
 * Why sending failed, in the customer's words. A lost answer keeps the same
 * idempotency key, so "try again" is always safe: the bank answers the first
 * request instead of sending twice (TRF-5).
 */
export function sendErrorMessage(error: ApiError | Error): SendError {
  if (!isApiError(error)) {
    return {
      message: "We couldn't send it. Nothing has left your account. Try again.",
      requote: false,
    };
  }
  const { code, title, detail } = error.problem;
  switch (code) {
    case 'quote_expired':
      return {
        message: 'The fee or limit changed. Check the new total and confirm again.',
        requote: true,
      };
    case 'insufficient_funds':
    case 'limit_exceeded':
    case 'validation_failed':
      return { message: detail ?? title, requote: true };
    case 'offline':
      return {
        message: "You're offline. Reconnect and try again; it won't send twice.",
        requote: false,
      };
    case 'gateway_timeout':
    case 'service_unavailable':
    case 'network_error':
      return {
        message: "We didn't hear back. Try again: if it already went through, it won't send twice.",
        requote: false,
      };
    default:
      return { message: detail ?? "We couldn't send it. Try again.", requote: false };
  }
}
