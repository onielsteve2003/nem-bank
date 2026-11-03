import { COLORS, DURATION, RADIUS, SPACING, type ColorScheme, type ColorTokens } from '@nem/shared';

// The console reads the same Volt Noir tokens as the mobile app. They become CSS
// custom properties so stylesheets never hold a hex value of their own.

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function colorVars(tokens: ColorTokens): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--color-${kebab(name)}: ${value};`)
    .join(' ');
}

function scaleVars(): string {
  const spacing = Object.entries(SPACING).map(([k, v]) => `--space-${k}: ${v}px;`);
  const radius = Object.entries(RADIUS).map(([k, v]) => `--radius-${k}: ${v}px;`);
  const duration = Object.entries(DURATION).map(([k, v]) => `--duration-${k}: ${v}ms;`);
  return [...spacing, ...radius, ...duration].join(' ');
}

const block = (selector: string, scheme: ColorScheme): string =>
  `${selector} { color-scheme: ${scheme}; ${colorVars(COLORS[scheme])} }`;

/**
 * Dark is the default. The OS preference picks light unless the user chose a theme,
 * which is stored as `data-theme` on <html>.
 */
export function buildThemeCss(): string {
  return [
    `:root { ${scaleVars()} }`,
    block(':root', 'dark'),
    `@media (prefers-color-scheme: light) { ${block(':root:not([data-theme="dark"])', 'light')} }`,
    block(':root[data-theme="light"]', 'light'),
    block(':root[data-theme="dark"]', 'dark'),
  ].join('\n');
}

export function installThemeCss(doc: Document = document): void {
  const style = doc.createElement('style');
  style.dataset.nemTokens = '';
  style.textContent = buildThemeCss();
  doc.head.prepend(style);
}
