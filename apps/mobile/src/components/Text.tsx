import type { ColorTokens, TypeVariant } from '@nem/shared';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { useTheme } from '@/theme';

export type TextColor = keyof Pick<
  ColorTokens,
  | 'text'
  | 'textMuted'
  | 'primaryText'
  | 'onPrimary'
  | 'danger'
  | 'success'
  | 'warning'
  | 'info'
  | 'onStatus'
>;

export type Props = TextProps & {
  variant?: TypeVariant;
  color?: TextColor;
  align?: TextStyle['textAlign'];
  /** Fixed-width digits so amounts line up and don't jitter while counting. Defaults on for amounts. */
  tabular?: boolean;
};

const HEADINGS: ReadonlySet<TypeVariant> = new Set(['display', 'h1', 'h2', 'h3']);
const AMOUNTS: ReadonlySet<TypeVariant> = new Set(['amount', 'amountLarge']);

// Text grows with the OS text size (dynamic type). Big display sizes are capped
// lower so a large balance still fits on one line at the largest settings.
const LARGE_TEXT_CAP = 1.4;
const BODY_TEXT_CAP = 2;

export function Text({
  variant = 'body',
  color = 'text',
  align,
  tabular = AMOUNTS.has(variant),
  style,
  ...rest
}: Props) {
  const { colors, type } = useTheme();
  const large = HEADINGS.has(variant) || AMOUNTS.has(variant);

  return (
    <RNText
      accessibilityRole={HEADINGS.has(variant) ? 'header' : undefined}
      maxFontSizeMultiplier={large ? LARGE_TEXT_CAP : BODY_TEXT_CAP}
      {...rest}
      style={[
        type[variant],
        { color: colors[color], textAlign: align },
        tabular && { fontVariant: ['tabular-nums'] },
        style,
      ]}
    />
  );
}
