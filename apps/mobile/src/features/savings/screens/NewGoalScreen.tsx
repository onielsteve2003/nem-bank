import { addDaysIso, lagosToday, parseDisplayDate, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { CalendarDays } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AmountInput, Button, PressableScale, Screen, Text, TextField } from '@/components';
import { typedNaira } from '@/features/transfers/amount';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import i18n from '@/lib/i18n';
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
  if (!iso) return i18n.t('savings.newGoal.dateInvalid');
  if (iso <= today) return i18n.t('savings.newGoal.dateAfterToday');
  if (iso > addDaysIso(today, MAX_DAYS)) return i18n.t('savings.newGoal.dateTooFar');
  return null;
}

/**
 * New savings goal (SAV-2): a name and emoji, a target, an optional date to
 * reach it by and an optional auto-save rule. Money moves in from the goal.
 */
export function NewGoalScreen() {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
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
        onError: () => setError(t('savings.newGoal.failed')),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('savings.newGoal.title')} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={t('savings.newGoal.create')}
          disabled={!ready}
          loading={create.isPending}
          onPress={onCreate}
        />
      }
    >
      <TextField
        label={t('savings.newGoal.name')}
        placeholder={t('savings.newGoal.namePlaceholder')}
        value={name}
        onChangeText={setName}
        maxLength={MAX_GOAL_NAME}
        autoCapitalize="sentences"
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          {t('savings.newGoal.emoji')}
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
        label={t('savings.newGoal.target')}
        value={target}
        onChangeValue={setTarget}
        maxWholeDigits={9}
      />

      <TextField
        label={t('savings.newGoal.date')}
        placeholder={t('savings.newGoal.datePlaceholder')}
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
        {t('savings.newGoal.note')}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  emoji: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 24 },
});
