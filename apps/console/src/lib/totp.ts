import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';

// RFC 6238 TOTP (HMAC-SHA1, 30 s steps, 6 digits): what Google Authenticator,
// 1Password and Authy expect. The mock back office verifies codes with it and the
// login page's demo authenticator generates them, so the second step is real.

export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new TypeError(`invalid base32 character: ${char}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secret: Uint8Array, counter: number): string {
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const mac = hmac(sha1, secret, message);
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export const totpCounter = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

export function totp(secretBase32: string, nowMs: number): string {
  return hotp(base32Decode(secretBase32), totpCounter(nowMs));
}

/** Seconds until the current code rolls over. */
export const totpSecondsLeft = (nowMs: number): number =>
  TOTP_STEP_SECONDS - (Math.floor(nowMs / 1000) % TOTP_STEP_SECONDS);

/**
 * Accepts the current step and one either side, so a phone clock a few seconds off
 * still works (RFC 6238 §5.2). Returns the matched counter so a code can't be replayed.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretBase32);
  const current = totpCounter(nowMs);
  for (const counter of [current, current - 1, current + 1]) {
    if (hotp(key, counter) === code) return counter;
  }
  return null;
}

export function otpauthUri(secretBase32: string, email: string): string {
  const label = encodeURIComponent(`Nem Console:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=Nem%20Console&digits=6&period=30`;
}
