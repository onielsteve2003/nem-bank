import { describe, expect, it } from 'vitest';

import { base32Decode, hotp, otpauthUri, totp, totpSecondsLeft, verifyTotp } from './totp';

// RFC 6238 Appendix B secret "12345678901234567890" in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('decodes base32', () => {
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET))).toBe('12345678901234567890');
  });

  it('matches the RFC 4226 HOTP test vectors', () => {
    const key = base32Decode(RFC_SECRET);
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('matches the RFC 6238 SHA-1 vectors (last 6 digits)', () => {
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totp(RFC_SECRET, 2_000_000_000_000)).toBe('279037');
  });

  it('accepts one step of clock drift either side and nothing further', () => {
    const now = 1_111_111_109_000;
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + 30_000), now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now - 90_000), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', now)).toBeNull();
  });

  it('counts down to the next step', () => {
    expect(totpSecondsLeft(0)).toBe(30);
    expect(totpSecondsLeft(29_000)).toBe(1);
  });

  it('builds an otpauth URI the contract accepts', () => {
    expect(otpauthUri(RFC_SECRET, 'a@nem.bank')).toMatch(
      /^otpauth:\/\/totp\/Nem%20Console%3Aa%40nem\.bank\?secret=/,
    );
  });
});
