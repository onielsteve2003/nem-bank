import { useEffect, useState } from 'react';

import { isApiError, type ApiError } from '@/data';
import i18n from '@/lib/i18n';

// Email code helpers shared by sign-up, forgot password and step-up (AUTH-2, AUTH-9).

/** Whole seconds until `iso`, ticking once a second; 0 once it has passed. */
export function useSecondsUntil(iso: string): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Rounded, not ceiled: a fresh 60 s cooldown read a moment late still says 1:00.
  return Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What the user is told for a failed check. Attempts come from the challenge (AUTH-2). */
export function otpErrorMessage(error: ApiError | Error, attemptsLeft: number): string {
  if (!isApiError(error)) return i18n.t('auth.otp.checkFailed');
  switch (error.problem.code) {
    case 'invalid_otp':
      return attemptsLeft > 0
        ? i18n.t('auth.otp.wrong', { count: attemptsLeft })
        : i18n.t('auth.otp.lastTry');
    case 'otp_expired':
    case 'not_found':
      return i18n.t('auth.otp.expired');
    case 'rate_limited':
      return i18n.t('auth.otp.tooMany');
    case 'offline':
      return i18n.t('common.offline');
    default:
      return i18n.t('auth.otp.checkFailed');
  }
}
