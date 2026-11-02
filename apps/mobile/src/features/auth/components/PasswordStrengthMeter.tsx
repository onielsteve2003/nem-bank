import type { PasswordCheck } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

const SEGMENTS = 4;

/** Four bars and a word (never colour alone), read out as one value. */
export function PasswordStrengthMeter({ check }: { check: PasswordCheck }) {
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const tone =
    check.score <= 1 ? colors.danger : check.score === 2 ? colors.warning : colors.success;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('auth.password.strength')}
      accessibilityValue={{ min: 0, max: SEGMENTS, now: check.score, text: check.label }}
      style={{ gap: spacing[1] }}
    >
      <View style={[styles.bars, { gap: spacing[1] }]}>
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                borderRadius: radius.sm,
                backgroundColor: i < check.score ? tone : colors.border,
              },
            ]}
          />
        ))}
      </View>
      <Text variant="label" color="textMuted">
        {t('auth.password.strengthValue', { label: check.label })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bars: { flexDirection: 'row' },
  bar: { flex: 1, height: 4 },
});
