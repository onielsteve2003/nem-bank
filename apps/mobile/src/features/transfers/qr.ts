import type { Schema } from '@nem/contracts';

import { resolveDeepLink } from '@/lib/deepLinks';

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
export const QR_INVALID: Record<InvalidReason | 'other', { title: string; message: string }> = {
  expired: {
    title: 'This code has expired',
    message: 'Codes with an amount last 15 minutes. Ask them to show a fresh one.',
  },
  bad_signature: {
    title: "This code isn't genuine",
    message:
      "It wasn't made by Nem, or it was changed. Don't pay it. Ask for their @nemtag instead.",
  },
  unknown_account: {
    title: 'We don’t know this account',
    message: 'The account on this code is closed or does not exist.',
  },
  not_nem_qr: {
    title: "That isn't a Nem code",
    message: 'Scan a Nem QR code or a Nem pay link.',
  },
  other: {
    title: "That isn't a Nem code",
    message: 'Scan a Nem QR code or a Nem pay link.',
  },
};

/** "14:59" until a code with an amount stops working. */
export function countdown(expiresAt: string, now: number = Date.now()): string {
  const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  const minutes = Math.floor(left / 60);
  return `${minutes}:${String(left % 60).padStart(2, '0')}`;
}
