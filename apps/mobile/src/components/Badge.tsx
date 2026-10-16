import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';
import { TONE_PALETTE, type Tone } from './tone';

export const MAX_BADGE_COUNT = 99;

/** "99+" past the cap so a badge never grows wider than a few characters. */
export function badgeCountLabel(count: number): string {
  return count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(Math.max(0, Math.floor(count)));
}

type Common = { tone?: Tone };

export type Props = Common &
  (
    | { label: string; accessibilityLabel?: string }
    | { count: number; accessibilityLabel?: string }
    // A bare dot says nothing to a screen reader, so it must carry a label.
    | { dot: true; accessibilityLabel: string }
  );

/** A small label, a count (e.g. unread) or a dot. A count of zero renders nothing. */
export function Badge({ tone = 'neutral', ...props }: Props) {
  const { colors, radius, spacing } = useTheme();
  const palette = TONE_PALETTE[tone];

  if ('count' in props && props.count <= 0) return null;
  const isDot = 'dot' in props;
  const text =
    'label' in props ? props.label : 'count' in props ? badgeCountLabel(props.count) : null;
  const spoken =
    props.accessibilityLabel ?? ('count' in props ? `${text} new` : (text ?? undefined));

  return (
    <View
      accessible
      accessibilityLabel={spoken}
      style={[
        isDot ? styles.dot : styles.pill,
        {
          borderRadius: radius.pill,
          backgroundColor: colors[palette.fill],
          paddingHorizontal: isDot ? 0 : spacing[2],
        },
      ]}
    >
      {text !== null && (
        <Text variant="caption" style={{ color: colors[palette.fg] }} maxFontSizeMultiplier={1.4}>
          {text}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    minWidth: 20,
    minHeight: 20,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  dot: { width: 8, height: 8 },
});
