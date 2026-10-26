import type { Schema } from '@nem/contracts';
import { StyleSheet, View } from 'react-native';

import { MoneyText, PressableScale, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { goalSubtitle } from '../goals';
import { GoalProgress } from './GoalProgress';

/** A goal in a list: emoji, name, what is saved and the progress bar. */
export function GoalRow({
  goal,
  hidden,
  onPress,
}: {
  goal: Schema<'SavingsGoal'>;
  hidden: boolean;
  onPress?: () => void;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${goal.name}, ${goal.progress_pct}% saved. ${goalSubtitle(goal)}`}
      disabled={!onPress}
      onPress={onPress}
      style={[
        styles.row,
        {
          backgroundColor: colors.surface,
          borderRadius: radius.lg,
          padding: spacing[4],
          gap: spacing[3],
        },
      ]}
    >
      <View style={[styles.emoji, { backgroundColor: colors.raised, borderRadius: radius.pill }]}>
        <Text style={styles.emojiText}>{goal.emoji}</Text>
      </View>
      <View style={[styles.flex, { gap: spacing[2] }]}>
        <View style={styles.between}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.flex}>
            {goal.name}
          </Text>
          <MoneyText value={fromApiMoney(goal.balance)} variant="bodyStrong" masked={hidden} />
        </View>
        <GoalProgress goal={goal} hidden={hidden} />
        <Text variant="caption" color="textMuted">
          {goalSubtitle(goal)}
        </Text>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  emoji: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 22 },
  flex: { flex: 1 },
  between: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
