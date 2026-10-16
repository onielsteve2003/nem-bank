// "Volt Noir" palette (architecture-context §8). Components read these through
// `useTheme()`; no hex values belong anywhere else.

export type ColorScheme = 'dark' | 'light';

export interface ColorTokens {
  /** App background. */
  readonly background: string;
  /** Cards, sheets, list rows. */
  readonly surface: string;
  /** Elements sitting on a surface: inputs, pressed rows, chips. */
  readonly raised: string;
  readonly border: string;
  readonly text: string;
  readonly textMuted: string;
  /** Brand fill for primary buttons and highlights. */
  readonly primary: string;
  /** Text and icons placed on a `primary` fill. */
  readonly onPrimary: string;
  /** Brand colour used as text or an icon on `background`/`surface`. */
  readonly primaryText: string;
  readonly danger: string;
  readonly success: string;
  readonly warning: string;
  readonly info: string;
  /** Text and icons placed on a danger/success/warning/info fill. */
  readonly onStatus: string;
  /** Scrim behind sheets and dialogs. */
  readonly overlay: string;
}

const INK = '#0B0D12';
const VOLT = '#D4FF3A';

export const COLORS: Readonly<Record<ColorScheme, ColorTokens>> = {
  dark: {
    background: INK,
    surface: '#14171F',
    raised: '#1C2029',
    border: '#2A2F3A',
    text: '#F5F7FA',
    textMuted: '#9AA3B2',
    primary: VOLT,
    onPrimary: INK,
    primaryText: VOLT,
    danger: '#FF6B5B',
    success: '#3DDC97',
    warning: '#FFB547',
    info: '#5AC8FA',
    onStatus: INK,
    overlay: 'rgba(0, 0, 0, 0.6)',
  },
  // Volt fails contrast as text on paper, so light mode uses it as a fill only and
  // swaps every status colour for a darker shade that passes AA on paper.
  light: {
    background: '#F7F7F2',
    surface: '#FFFFFF',
    raised: '#EDEDE6',
    border: '#D9D9D0',
    text: INK,
    textMuted: '#555D6B',
    primary: VOLT,
    onPrimary: INK,
    primaryText: '#3F5200',
    danger: '#C2362A',
    success: '#167A4F',
    warning: '#8A5300',
    info: '#0B6A9A',
    onStatus: '#FFFFFF',
    overlay: 'rgba(11, 13, 18, 0.45)',
  },
};
