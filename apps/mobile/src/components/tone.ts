import type { ColorTokens } from '@nem/shared';

/** Shared status palette for small labelled fills (Badge, and StatusPill later). */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

export const TONE_PALETTE: Record<Tone, { fill: keyof ColorTokens; fg: keyof ColorTokens }> = {
  neutral: { fill: 'raised', fg: 'text' },
  primary: { fill: 'primary', fg: 'onPrimary' },
  success: { fill: 'success', fg: 'onStatus' },
  warning: { fill: 'warning', fg: 'onStatus' },
  danger: { fill: 'danger', fg: 'onStatus' },
  info: { fill: 'info', fg: 'onStatus' },
};
