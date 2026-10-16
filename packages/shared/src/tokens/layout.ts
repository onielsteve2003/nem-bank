/** 4-pt spacing scale (code-standards §6). Keys are multiples of 4. */
export const SPACING = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export type SpacingKey = keyof typeof SPACING;

export const RADIUS = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

/** Smallest touch target, in points (WCAG 2.5.8, iOS HIG). */
export const MIN_TOUCH_TARGET = 44;

export interface Elevation {
  readonly shadowColor: string;
  readonly shadowOffset: { readonly width: number; readonly height: number };
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  /** Android elevation. */
  readonly elevation: number;
}

const shadow = (height: number, opacity: number, radius: number, elevation: number): Elevation => ({
  shadowColor: '#000000',
  shadowOffset: { width: 0, height },
  shadowOpacity: opacity,
  shadowRadius: radius,
  elevation,
});

// Shadows barely show on a near-black background, so dark mode separates layers
// with the surface/raised colours and these stay subtle.
export const ELEVATION = {
  none: shadow(0, 0, 0, 0),
  low: shadow(1, 0.08, 3, 1),
  medium: shadow(4, 0.12, 12, 4),
  high: shadow(12, 0.18, 24, 12),
} as const;
