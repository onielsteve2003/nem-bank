import type { Schema } from '@nem/contracts';

import { resolveDeepLink } from '@/lib/deepLinks';
import i18n from '@/lib/i18n';

type InvalidReason = NonNullable<Schema<'DecodedQr'>['invalid_reason']>;

/**
 * What a scanned code is: a signed Nem payment QR, a Nem pay link (QR codes on
 * payment links carry the link), or something that is not ours.
 */
export type ScannedCode =
  { kind: 'nem_qr'; payload: string } | { kind: 'pay_link'; url: string } | { kind: 'other' };

export function classifyScan(text: string): ScannedCode {
  const raw = text.trim();
  const { href } = resolveDeepLink(raw);
  if (typeof href === 'object' && href.pathname === '/qr') {
    const payload = (href.params as { payload?: string } | undefined)?.payload;
    if (payload) return { kind: 'nem_qr', payload };
  }
  if (typeof href === 'object' && href.pathname === '/pay/[slug]')
    return { kind: 'pay_link', url: raw };
  return { kind: 'other' };
}

/** Why the bank refused a scanned code, and what to do about it. */
const invalid = (reason: InvalidReason) => ({
  get title() {
    return i18n.t(`transfers.qr.invalid.${reason}.title`);
  },
  get message() {
    return i18n.t(`transfers.qr.invalid.${reason}.message`);
  },
});

export const QR_INVALID: Record<
  InvalidReason | 'other',
  { readonly title: string; readonly message: string }
> = {
  expired: invalid('expired'),
  bad_signature: invalid('bad_signature'),
  unknown_account: invalid('unknown_account'),
  not_nem_qr: invalid('not_nem_qr'),
  other: invalid('not_nem_qr'),
};

/** "14:59" until a code with an amount stops working. */
export function countdown(expiresAt: string, now: number = Date.now()): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(left / 60);
  return `${minutes}:${String(left % 60).padStart(2, '0')}`;
}
