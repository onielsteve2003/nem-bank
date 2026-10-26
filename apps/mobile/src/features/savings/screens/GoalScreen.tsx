import type { Schema } from '@nem/contracts';
import { formatMoney, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ArrowDownToLine, ArrowUpFromLine, Repeat, Target, XCircle } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  BottomSheet,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  ListItem,
  MoneyText,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoMutation, useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { AutoSaveFields, type AutoSaveChoice } from '../components/AutoSaveFields';
import { GoalProgress } from '../components/GoalProgress';
import { MoveMoneySheet } from '../components/MoveMoneySheet';
import { describeAutoSave, formatGoalDate, goalSubtitle } from '../goals';

type Goal = Schema<'SavingsGoal'>;

const choiceOf = (goal: Goal): AutoSaveChoice | null =>
  goal.auto_save
    ? {
        amount: Number(fromApiMoney(goal.auto_save.amount).amount / 100n),
        frequency: goal.auto_save.frequency,
      }
    : null;

function AutoSaveSheet({
  goal,
  accountId,
  onClose,
}: {
  goal: Goal;
  accountId: string;
  onClose: () => void;
}) {
  const { spacing } = useTheme();
  const [choice, setChoice] = useState(choiceOf(goal));
  const [error, setError] = useState<string>();
  const update = useRepoMutation('savings', 'updateGoal', { invalidates: [['savings']] });
  const save = () => {
    setError(undefined);
    update.mutate(
      {
        path: { goal_id: goal.id },
        body: {
          auto_save: choice
            ? {
                amount: toApiMoney(parseMajor(String(choice.amount), 'NGN')),
                frequency: choice.frequency,
                source_account_id: accountId,
              }
            : null,
        },
      },
      { onSuccess: onClose, onError: () => setError("We couldn't save it. Try again.") },
    );
  };
  return (
    <BottomSheet open onClose={onClose} title="Auto-save">
      <View style={{ gap: spacing[4] }}>
        <AutoSaveFields value={choice} onChange={setChoice} />
        {error && (
          <Text variant="bodySmall" color="danger" accessibilityRole="alert">
            {error}
          </Text>
        )}
        <Button label="Save" loading={update.isPending} onPress={save} />
      </View>
    </BottomSheet>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between}>
      <Text color="textMuted">{label}</Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

/**
 * One savings goal (SAV-2): progress to the target, add money, withdraw, the
 * auto-save rule and interest; closing it sends what is saved back to naira.
 */
export function GoalScreen({ id }: { id: string }) {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const goalQuery = useRepoQuery('savings', 'getGoal', { path: { goal_id: id } });
  const accounts = useRepoQuery('accounts', 'list');
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const [moving, setMoving] = useState<'deposit' | 'withdraw' | null>(null);
  const [editingAutoSave, setEditingAutoSave] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string>();
  const close = useMoneyMutation('savings', 'closeGoal', {
    invalidates: [['savings'], ['accounts'], ['transactions']],
  });

  const goal = goalQuery.data;
  const isOpen = goal ? goal.status !== 'closed' : false;
  const balance = goal ? fromApiMoney(goal.balance) : null;

  return (
    <Screen
      header={<SendHeader title={goal ? `${goal.emoji} ${goal.name}` : 'Goal'} />}
      edges={['top', 'bottom']}
      onRefresh={() => void goalQuery.refetch()}
      refreshing={goalQuery.isRefetching}
    >
      {goalQuery.isError ? (
        <ErrorState title="We couldn't load this goal" onRetry={() => goalQuery.refetch()} />
      ) : !goal || !balance ? (
        <SkeletonGroup accessibilityLabel="Loading goal">
          <Skeleton height={160} radius={24} />
          <Skeleton height={120} />
        </SkeletonGroup>
      ) : (
        <>
          <View
            accessibilityRole="summary"
            style={{
              backgroundColor: colors.surface,
              borderRadius: radius.xl,
              padding: spacing[5],
              gap: spacing[3],
            }}
          >
            <Text variant="label" color="textMuted">
              Saved
            </Text>
            <MoneyText
              value={balance}
              variant="amountLarge"
              masked={hidden}
              animate
              label="Saved"
            />
            <GoalProgress goal={goal} hidden={hidden} />
            <View style={styles.between}>
              <Text variant="caption" color="textMuted">
                {goalSubtitle(goal)}
              </Text>
              <Text variant="caption" color="textMuted">
                {hidden ? 'Target hidden' : `of ${formatMoney(fromApiMoney(goal.target))}`}
              </Text>
            </View>
          </View>

          {goal.status === 'completed' && (
            <EmptyState
              icon={Target}
              title="You reached your target"
              message="Well done. Keep it here to earn interest, or withdraw it when you're ready."
            />
          )}

          {isOpen && (
            <View style={[styles.actions, { gap: spacing[3] }]}>
              <Button
                label="Add money"
                icon={ArrowDownToLine}
                style={styles.flex}
                disabled={!naira}
                onPress={() => setMoving('deposit')}
              />
              <Button
                label="Withdraw"
                icon={ArrowUpFromLine}
                variant="secondary"
                style={styles.flex}
                disabled={!naira || balance.amount <= 0n}
                onPress={() => setMoving('withdraw')}
              />
            </View>
          )}

          <Card>
            <View style={{ gap: spacing[3] }}>
              <Row
                label="Target"
                value={hidden ? '••••' : formatMoney(fromApiMoney(goal.target))}
              />
              <Row
                label="Reach it by"
                value={goal.target_date ? formatGoalDate(goal.target_date) : 'No date'}
              />
              <Row label="Interest" value={`${goal.interest_rate_bps / 100}% a year`} />
              <Row
                label="Interest earned"
                value={hidden ? '••••' : formatMoney(fromApiMoney(goal.interest_earned))}
              />
            </View>
          </Card>

          {isOpen && (
            <Card padded={false}>
              <ListItem
                leading={Repeat}
                title="Auto-save"
                subtitle={
                  goal.auto_save
                    ? `${describeAutoSave(
                        formatMoney(fromApiMoney(goal.auto_save.amount), { trimZeroMinor: true }),
                        goal.auto_save.frequency,
                      )} from your naira account`
                    : 'Off · save on a schedule without thinking about it'
                }
                onPress={() => setEditingAutoSave(true)}
                accessibilityHint="Turn auto-save on or off, or change it"
              />
            </Card>
          )}

          {closeError && (
            <Text variant="bodySmall" color="danger" accessibilityRole="alert">
              {closeError}
            </Text>
          )}
          {isOpen && (
            <Button
              label="Close goal"
              icon={XCircle}
              variant="ghost"
              onPress={() => {
                close.resetIntent();
                setClosing(true);
              }}
            />
          )}
        </>
      )}

      {moving && goal && naira && (
        <MoveMoneySheet kind={moving} goal={goal} account={naira} onClose={() => setMoving(null)} />
      )}
      {editingAutoSave && goal && naira && (
        <AutoSaveSheet goal={goal} accountId={naira.id} onClose={() => setEditingAutoSave(false)} />
      )}
      <Dialog
        open={closing}
        title={`Close ${goal?.name ?? 'this goal'}?`}
        message={
          balance && balance.amount > 0n
            ? `${formatMoney(balance)} goes back to your naira account and auto-save stops.`
            : 'Auto-save stops and the goal moves to Closed.'
        }
        confirmLabel="Close goal"
        cancelLabel="Keep it"
        destructive
        loading={close.isPending}
        onCancel={() => setClosing(false)}
        onConfirm={() => {
          setCloseError(undefined);
          close.mutate(
            { path: { goal_id: id } },
            {
              onSuccess: () => {
                setClosing(false);
                router.back();
              },
              onError: () => {
                setClosing(false);
                setCloseError("We couldn't close it. Try again.");
              },
            },
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row' },
  flex: { flex: 1 },
});
