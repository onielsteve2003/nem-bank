import { COLORS } from '@nem/shared';
import { describe, expect, it } from 'vitest';

import { buildThemeCss } from './cssVars';

describe('buildThemeCss', () => {
  const css = buildThemeCss();

  it('exposes every shared colour token for both schemes', () => {
    for (const value of [...Object.values(COLORS.dark), ...Object.values(COLORS.light)]) {
      expect(css).toContain(value);
    }
    expect(css).toContain('--color-primary-text: #3F5200;');
    expect(css).toContain('--color-on-primary:');
  });

  it('defaults to dark and lets an explicit choice override the OS preference', () => {
    expect(css).toContain(`:root { color-scheme: dark;`);
    expect(css).toContain(`:root:not([data-theme="dark"]) { color-scheme: light;`);
    expect(css).toContain(`:root[data-theme="light"] { color-scheme: light;`);
  });

  it('emits the 4-pt spacing scale and radii', () => {
    expect(css).toContain('--space-4: 16px;');
    expect(css).toContain('--radius-md: 12px;');
  });
});
