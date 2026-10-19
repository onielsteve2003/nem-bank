import { nemtagIdeas, nemtagProblem, normalizeNemtag } from './nemtag';

describe('normalizeNemtag', () => {
  it('drops the @, spaces and capitals', () => {
    expect(normalizeNemtag('  @Tolu_A ')).toBe('tolu_a');
  });
});

describe('nemtagProblem', () => {
  it.each(['tolu', 'tolu_a', 'ada2026', 'a'.repeat(20)])('accepts %s', (tag) => {
    expect(nemtagProblem(tag)).toBeNull();
  });

  it.each([
    ['to', 'Use at least 3 characters'],
    ['a'.repeat(21), 'Use at most 20 characters'],
    ['2pac', 'Start with a letter'],
    ['_tolu', 'Start with a letter'],
    ['tolu.a', 'Use only letters, numbers and _'],
    ['admin', 'This one is reserved. Try another.'],
  ])('refuses %s', (tag, message) => {
    expect(nemtagProblem(tag)).toBe(message);
  });
});

describe('nemtagIdeas', () => {
  it('builds valid tags from a name, accents and spaces removed', () => {
    expect(nemtagIdeas('Tolulope', 'Adébayo')).toEqual([
      'tolulope',
      'tolulope_a',
      'tolulope_adebayo',
    ]);
  });

  it('skips ideas that would break the rules', () => {
    expect(nemtagIdeas('Al', 'O', 5)).toEqual(['al_o', 'alo', 'o_al']);
  });
});
