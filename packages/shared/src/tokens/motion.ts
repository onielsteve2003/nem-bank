// Motion stays within 150–300 ms (architecture-context §8). When the OS asks for
// reduced motion, components skip these and change state instantly.

export const DURATION = {
  fast: 150,
  base: 220,
  slow: 300,
} as const;

/** Cubic-bezier control points, for Reanimated `Easing.bezier(...)` or CSS. */
export const EASING = {
  standard: [0.2, 0, 0, 1],
  enter: [0, 0, 0, 1],
  exit: [0.3, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** Reanimated `withSpring` configs. */
export const SPRING = {
  snappy: { damping: 20, stiffness: 300, mass: 1 },
  gentle: { damping: 18, stiffness: 180, mass: 1 },
  bouncy: { damping: 12, stiffness: 220, mass: 1 },
} as const;
