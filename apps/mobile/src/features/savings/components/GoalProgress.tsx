import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { fromApiMoney } from '@/lib/money';

/** How far a savings goal is: a bar that turns green once the target is reached. */
export function GoalProgress({
  goal,
  hidden = false,
}: {
  goal: Schema<'SavingsGoal'>;
  hidden?: boolean;
}) {
  const { colors, radius } = useTheme();
  const pct = Math.max(0, Math.min(100, goal.progress_pct));
  const label = hidden
    ? `${pct}% of the target saved`
    : `${formatMoney(fromApiMoney(goal.balance))} of ${formatMoney(fromApiMoney(goal.target))} saved`;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={[styles.track, { backgroundColor: colors.border, borderRadius: radius.pill }]}
    >
      <View
        style={[
          styles.fill,
          {
            width: `${pct}%`,
            backgroundColor: pct >= 100 ? colors.success : colors.primary,
            borderRadius: radius.pill,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { height: 8, overflow: 'hidden' },
  fill: { height: '100%' },
});
