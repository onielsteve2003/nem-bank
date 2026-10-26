import { addDaysIso, lagosToday, parseDisplayDate, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { CalendarDays } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountInput, Button, PressableScale, Screen, Text, TextField } from '@/components';
import { typedNaira } from '@/features/transfers/amount';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { AutoSaveFields, type AutoSaveChoice } from '../components/AutoSaveFields';
import { GOAL_EMOJIS, MAX_GOAL_NAME } from '../goals';

/** Goals can be at most ten years out. */
const MAX_DAYS = 3_650;

/** Why the typed target date can't be used, or null. */
export function targetDateError(typed: string, today: string): string | null {
  if (!typed) return null;
  if (typed.length < 10) return null;
  const iso = parseDisplayDate(typed);
  if (!iso) return 'Use a real date in DD/MM/YYYY';
  if (iso <= today) return 'Pick a day after today';
  if (iso > addDaysIso(today, MAX_DAYS)) return 'Pick a day within ten years';
  return null;
}

/**
 * New savings goal (SAV-2): a name and emoji, a target, an optional date to
 * reach it by and an optional auto-save rule. Money moves in from the goal.
 */
export function NewGoalScreen() {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const accounts = useRepoQuery('accounts', 'list');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(GOAL_EMOJIS[0]!);
  const [target, setTarget] = useState('');
  const [date, setDate] = useState('');
  const [autoSave, setAutoSave] = useState<AutoSaveChoice | null>(null);
  const [error, setError] = useState<string>();
  const create = useMoneyMutation('savings', 'createGoal', { invalidates: [['savings']] });

  const today = lagosToday();
  const amount = typedNaira(target);
  const dateError = targetDateError(date, today);
  const targetDate = date ? parseDisplayDate(date) : null;
  const ready =
    Boolean(name.trim() && amount && source) && !dateError && (!date || Boolean(targetDate));

  const onCreate = () => {
    if (!amount || !source) return;
    setError(undefined);
    create.mutate(
      {
        body: {
          name: name.trim(),
          emoji,
          target: toApiMoney(amount),
          ...(targetDate ? { target_date: targetDate } : {}),
          ...(autoSave
            ? {
                auto_save: {
                  amount: toApiMoney(parseMajor(String(autoSave.amount), 'NGN')),
                  frequency: autoSave.frequency,
                  source_account_id: source.id,
                },
              }
            : {}),
        },
      },
      {
        onSuccess: (goal) => router.replace({ pathname: '/goals/[id]', params: { id: goal.id } }),
        onError: () => setError("We couldn't create the goal. Try again."),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title="New goal" />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label="Create goal"
          disabled={!ready}
          loading={create.isPending}
          onPress={onCreate}
        />
      }
    >
      <TextField
        label="What are you saving for?"
        placeholder="New laptop"
        value={name}
        onChangeText={setName}
        maxLength={MAX_GOAL_NAME}
        autoCapitalize="sentences"
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          Pick an emoji
        </Text>
        <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
          {GOAL_EMOJIS.map((e) => {
            const selected = e === emoji;
            return (
              <PressableScale
                key={e}
                accessibilityRole="radio"
                accessibilityLabel={e}
                accessibilityState={{ selected }}
                onPress={() => setEmoji(e)}
                style={[
                  styles.emoji,
                  {
                    borderRadius: radius.pill,
                    backgroundColor: selected ? colors.primary : colors.surface,
                  },
                ]}
              >
                <Text style={styles.emojiText}>{e}</Text>
              </PressableScale>
            );
          })}
        </View>
      </View>

      <AmountInput
        currency="NGN"
        label="Target"
        value={target}
        onChangeValue={setTarget}
        maxWholeDigits={9}
      />

      <TextField
        label="Reach it by (optional)"
        placeholder="DD/MM/YYYY"
        leadingIcon={CalendarDays}
        keyboardType="numbers-and-punctuation"
        value={date}
        onChangeText={setDate}
        maxLength={10}
        error={dateError ?? undefined}
      />

      <AutoSaveFields value={autoSave} onChange={setAutoSave} />

      {error && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}
      <Text variant="caption" color="textMuted">
        Goals earn 10% a year, worked out daily. Take your money out any time.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  emoji: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 24 },
});
