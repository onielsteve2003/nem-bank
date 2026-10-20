import type { Schema } from '@nem/contracts';

import { cleanNickname, coolingOffMessage, coolingOffUntil, formatUntil } from '../beneficiaries';

const NOW = Date.parse('2026-10-20T09:00:00Z');

const beneficiary = (over: Partial<Schema<'Beneficiary'>>): Schema<'Beneficiary'> => ({
  id: 'b1',
  kind: 'bank',
  name: 'Chidi Okonkwo',
  bank_code: '058',
  bank_name: 'GTBank',
  account_number: '0123456789',
  favourite: false,
  cooling_off_until: null,
  created_at: '2026-10-20T08:00:00Z',
  ...over,
});

describe('coolingOffUntil', () => {
  it('applies to someone new until the window ends', () => {
    const b = beneficiary({ cooling_off_until: '2026-10-20T15:00:00Z', last_paid_at: null });
    expect(coolingOffUntil(b, NOW)?.toISOString()).toBe('2026-10-20T15:00:00.000Z');
    expect(coolingOffUntil(b, Date.parse('2026-10-20T15:00:01Z'))).toBeNull();
  });

  it('ends with the first payment', () => {
    const b = beneficiary({
      cooling_off_until: '2026-10-20T15:00:00Z',
      last_paid_at: '2026-10-20T08:30:00Z',
    });
    expect(coolingOffUntil(b, NOW)).toBeNull();
  });

  it('never applies to trusted beneficiaries', () => {
    expect(coolingOffUntil(beneficiary({}), NOW)).toBeNull();
  });
});

it('names the day only when the wait ends on another day', () => {
  const later = new Date('2026-10-21T15:00:00Z');
  expect(formatUntil(new Date('2026-10-20T15:00:00Z'), NOW)).not.toMatch(/^[A-Z][a-z]{2} /);
  expect(formatUntil(later, NOW)).toMatch(/^[A-Z][a-z]{2} /);
  expect(coolingOffMessage(later, NOW)).toMatch(/^New: large payments need an extra check until /);
});

it('stores a blank nickname as none', () => {
  expect(cleanNickname('  ')).toBeNull();
  expect(cleanNickname(' Mummy ')).toBe('Mummy');
});
