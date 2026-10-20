import { copVerdict, isNuban, nemLookupQuery, searchBanks } from '../recipient';

describe('nemLookupQuery', () => {
  it.each([
    ['@Amaka_O', 'amaka_o'],
    ['kunle', 'kunle'],
    ['0420270000', '0420270000'],
    ['0803 123 4567', '08031234567'],
    ['+2348031234567', '2348031234567'],
  ])('looks up %s as %s', (input, query) => {
    expect(nemLookupQuery(input)).toBe(query);
  });

  it.each(['', '@ab', '080312', '18031234567', 'amaka o'])(
    'waits while %s is incomplete',
    (input) => {
      expect(nemLookupQuery(input)).toBeNull();
    },
  );
});

it('accepts only 10-digit account numbers', () => {
  expect(isNuban('0123456789')).toBe(true);
  expect(isNuban('012345678')).toBe(false);
  expect(isNuban('01234567a9')).toBe(false);
});

it('finds banks by name, short name or code, alphabetically', () => {
  const banks = [
    { code: '058', name: 'Guaranty Trust Bank', short_name: 'GTBank', logo_url: null },
    { code: '044', name: 'Access Bank', short_name: 'Access', logo_url: null },
  ];
  expect(searchBanks(banks, '').map((b) => b.code)).toEqual(['044', '058']);
  expect(searchBanks(banks, 'gtb').map((b) => b.code)).toEqual(['058']);
  expect(searchBanks(banks, '04').map((b) => b.code)).toEqual(['044']);
});

describe('copVerdict', () => {
  it('reassures on a match and lets the payment go on', () => {
    const v = copVerdict(
      { result: 'match', confidence: 1, expected_name: 'Chidi' },
      'Chidi Okonkwo',
    );
    expect(v).toMatchObject({ tone: 'success', needsAcknowledgement: false });
  });

  it('warns on a close match with both names', () => {
    const v = copVerdict(
      { result: 'close_match', confidence: 0.75, expected_name: 'Tolu Adebayo' },
      'Tolulope Adebayo',
    );
    expect(v.tone).toBe('warning');
    expect(v.message).toContain('Tolulope Adebayo');
    expect(v.message).toContain('Tolu Adebayo');
  });

  it('makes a mismatch something the customer must acknowledge', () => {
    const v = copVerdict(
      { result: 'no_match', confidence: 0, expected_name: 'John' },
      'Chidi Okonkwo',
    );
    expect(v).toMatchObject({ tone: 'danger', needsAcknowledgement: true });
    expect(v.message).toMatch(/Scammers/);
  });
});
