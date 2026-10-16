import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export type Props = {
  /** Centred text such as "or". */
  label?: string;
  /** Left inset so the line starts under list-row text, past a leading icon or avatar. */
  inset?: number;
};

/** A hairline separator. Hidden from screen readers unless it carries a label. */
export function Divider({ label, inset = 0 }: Props) {
  const { colors, spacing } = useTheme();
  const lineStyle = [styles.line, { backgroundColor: colors.border }];

  if (!label) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[lineStyle, { marginLeft: inset }]}
      />
    );
  }

  return (
    <View style={[styles.row, { gap: spacing[3], marginLeft: inset }]}>
      <View style={[lineStyle, styles.flex]} />
      <Text variant="caption" color="textMuted">
        {label}
      </Text>
      <View style={[lineStyle, styles.flex]} />
    </View>
  );
}

const styles = StyleSheet.create({
  line: { height: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
