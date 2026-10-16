// WCAG 2.x contrast ratio, used to keep every text/background pair at AA.

/** AA minimum for body text. */
export const AA_TEXT = 4.5;
/** AA minimum for large text (≥ 24 px, or ≥ 19 px bold) and UI parts such as icons. */
export const AA_LARGE = 3;

function channel(hex: string, offset: number): number {
  const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an opaque `#RRGGBB` colour. */
export function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new TypeError(`expected #RRGGBB, got ${hex}`);
  }
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** Contrast ratio between two opaque colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
