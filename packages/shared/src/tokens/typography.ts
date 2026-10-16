// Space Grotesk for display text and amounts, Inter for body text (both OFL).
// React Native needs one family name per weight; these match the names that
// `@expo-google-fonts` registers, so the font loader and the tokens agree.

export const FONT_FAMILY = {
  displayMedium: 'SpaceGrotesk_500Medium',
  displaySemiBold: 'SpaceGrotesk_600SemiBold',
  displayBold: 'SpaceGrotesk_700Bold',
  bodyRegular: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemiBold: 'Inter_600SemiBold',
} as const;

export type FontFamily = (typeof FONT_FAMILY)[keyof typeof FONT_FAMILY];

export interface TypeStyle {
  readonly fontFamily: FontFamily;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
}

export type TypeVariant =
  | 'display'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'title'
  | 'body'
  | 'bodyStrong'
  | 'bodySmall'
  | 'label'
  | 'caption'
  | 'amountLarge'
  | 'amount';

const style = (
  fontFamily: FontFamily,
  fontSize: number,
  lineHeight: number,
  letterSpacing = 0,
): TypeStyle => ({ fontFamily, fontSize, lineHeight, letterSpacing });

/** Sizes in points at the default text size; `Text` scales them with dynamic type. */
export const TYPE_SCALE: Readonly<Record<TypeVariant, TypeStyle>> = {
  display: style(FONT_FAMILY.displayBold, 40, 48, -0.8),
  h1: style(FONT_FAMILY.displayBold, 32, 40, -0.5),
  h2: style(FONT_FAMILY.displaySemiBold, 24, 32, -0.3),
  h3: style(FONT_FAMILY.displaySemiBold, 20, 28),
  title: style(FONT_FAMILY.bodySemiBold, 17, 24),
  body: style(FONT_FAMILY.bodyRegular, 16, 24),
  bodyStrong: style(FONT_FAMILY.bodySemiBold, 16, 24),
  bodySmall: style(FONT_FAMILY.bodyRegular, 14, 20),
  label: style(FONT_FAMILY.bodyMedium, 13, 18, 0.2),
  caption: style(FONT_FAMILY.bodyRegular, 12, 16, 0.2),
  amountLarge: style(FONT_FAMILY.displayBold, 40, 48, -0.5),
  amount: style(FONT_FAMILY.displaySemiBold, 20, 28),
};
