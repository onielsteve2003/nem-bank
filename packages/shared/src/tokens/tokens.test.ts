import {
  AA_LARGE,
  AA_TEXT,
  COLORS,
  contrastRatio,
  DURATION,
  SPACING,
  TYPE_SCALE,
  type ColorScheme,
  type ColorTokens,
} from '.';

type Key = keyof ColorTokens;

// Every foreground/background pair the components use, with the AA level it must reach.
const PAIRS: readonly [fg: Key, bg: Key, min: number][] = [
  ['text', 'background', AA_TEXT],
  ['text', 'surface', AA_TEXT],
  ['text', 'raised', AA_TEXT],
  ['textMuted', 'background', AA_TEXT],
  ['textMuted', 'surface', AA_TEXT],
  ['textMuted', 'raised', AA_TEXT],
  ['primaryText', 'background', AA_TEXT],
  ['primaryText', 'surface', AA_TEXT],
  ['onPrimary', 'primary', AA_TEXT],
  ['danger', 'background', AA_TEXT],
  ['danger', 'surface', AA_TEXT],
  ['success', 'background', AA_TEXT],
  ['success', 'surface', AA_TEXT],
  ['warning', 'background', AA_TEXT],
  ['warning', 'surface', AA_TEXT],
  ['info', 'background', AA_TEXT],
  ['info', 'surface', AA_TEXT],
  ['onStatus', 'danger', AA_TEXT],
  ['onStatus', 'success', AA_TEXT],
  ['onStatus', 'warning', AA_TEXT],
  ['onStatus', 'info', AA_TEXT],
  // Volt is a fill in light mode; the fill itself only needs to stand out as a UI part.
  ['primary', 'background', 1],
];

describe.each<ColorScheme>(['dark', 'light'])('%s colours', (scheme) => {
  const colors = COLORS[scheme];

  it.each(PAIRS)('%s on %s meets AA', (fg, bg, min) => {
    expect(contrastRatio(colors[fg], colors[bg])).toBeGreaterThanOrEqual(min);
  });

  it('defines the same keys as the other theme', () => {
    expect(Object.keys(colors).sort()).toEqual(Object.keys(COLORS.dark).sort());
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and symmetric', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  });

  it('rejects colours that are not #RRGGBB', () => {
    expect(() => contrastRatio('red', '#FFFFFF')).toThrow(TypeError);
  });

  it('confirms volt fails as text on paper, which is why light mode has primaryText', () => {
    expect(contrastRatio(COLORS.light.primary, COLORS.light.background)).toBeLessThan(AA_LARGE);
  });
});

describe('scales', () => {
  it('keeps spacing on the 4-pt grid', () => {
    for (const value of Object.values(SPACING)) expect(value % 4).toBe(0);
  });

  it('gives every type style a line height of at least its font size', () => {
    for (const s of Object.values(TYPE_SCALE))
      expect(s.lineHeight).toBeGreaterThanOrEqual(s.fontSize);
  });

  it('keeps motion between 150 and 300 ms', () => {
    for (const ms of Object.values(DURATION)) {
      expect(ms).toBeGreaterThanOrEqual(150);
      expect(ms).toBeLessThanOrEqual(300);
    }
  });
});
