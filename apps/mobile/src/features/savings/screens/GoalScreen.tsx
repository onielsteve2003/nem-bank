import type { Schema } from '@nem/contracts';
import { formatMoney, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ArrowDownToLine, ArrowUpFromLine, Repeat, Target, XCircle } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { DetailRow } from '../components/DetailRow';
import { GoalProgress } from '../components/GoalProgress';
import { MoveMoneySheet } from '../components/MoveMoneySheet';
import { describeAutoSave, formatGoalDate, goalSubtitle } from '../goals';
import { projectInterest } from '../projection';

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
  const { t } = useTranslation();
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
      { onSuccess: onClose, onError: () => setError(t('savings.autoSave.saveFailed')) },
    );
  };
  return (
    <BottomSheet open onClose={onClose} title={t('savings.autoSave.title')}>
      <View style={{ gap: spacing[4] }}>
        <AutoSaveFields value={choice} onChange={setChoice} />
        {error && (
          <Text variant="bodySmall" color="danger" accessibilityRole="alert">
            {error}
          </Text>
        )}
        <Button label={t('common.save')} loading={update.isPending} onPress={save} />
      </View>
    </BottomSheet>
  );
}

/**
 * One savings goal (SAV-2): progress to the target, add money, withdraw, the
 * auto-save rule and interest; closing it sends what is saved back to naira.
 */
export function GoalScreen({ id }: { id: string }) {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
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
      header={<SendHeader title={goal ? `${goal.emoji} ${goal.name}` : t('savings.goal.title')} />}
      edges={['top', 'bottom']}
      onRefresh={() => void goalQuery.refetch()}
      refreshing={goalQuery.isRefetching}
    >
      {goalQuery.isError ? (
        <ErrorState title={t('savings.goal.failed')} onRetry={() => goalQuery.refetch()} />
      ) : !goal || !balance ? (
        <SkeletonGroup accessibilityLabel={t('savings.goal.loading')}>
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
              {t('savings.goal.saved')}
            </Text>
            <MoneyText
              value={balance}
              variant="amountLarge"
              masked={hidden}
              animate
              label={t('savings.goal.saved')}
            />
            <GoalProgress goal={goal} hidden={hidden} />
            <View style={styles.between}>
              <Text variant="caption" color="textMuted">
                {goalSubtitle(goal)}
              </Text>
              <Text variant="caption" color="textMuted">
                {hidden
                  ? t('savings.goal.targetHidden')
                  : t('savings.goal.ofTarget', { amount: formatMoney(fromApiMoney(goal.target)) })}
              </Text>
            </View>
          </View>

          {goal.status === 'completed' && (
            <EmptyState
              icon={Target}
              title={t('savings.goal.reachedTitle')}
              message={t('savings.goal.reachedMessage')}
            />
          )}

          {isOpen && (
            <View style={[styles.actions, { gap: spacing[3] }]}>
              <Button
                label={t('common.addMoney')}
                icon={ArrowDownToLine}
                style={styles.flex}
                disabled={!naira}
                onPress={() => setMoving('deposit')}
              />
              <Button
                label={t('savings.move.withdraw')}
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
              <DetailRow
                label={t('savings.goal.target')}
                value={hidden ? t('common.masked') : formatMoney(fromApiMoney(goal.target))}
              />
              <DetailRow
                label={t('savings.goal.reachBy')}
                value={
                  goal.target_date ? formatGoalDate(goal.target_date) : t('savings.goal.noDate')
                }
              />
              <DetailRow
                label={t('savings.goal.interest')}
                value={t('savings.goal.rateYear', { rate: goal.interest_rate_bps / 100 })}
              />
              <DetailRow
                label={t('savings.goal.interestEarned')}
                value={
                  hidden ? t('common.masked') : formatMoney(fromApiMoney(goal.interest_earned))
                }
              />
              {isOpen && (
                <>
                  <DetailRow
                    label={t('savings.goal.projected30')}
                    value={
                      hidden
                        ? t('common.masked')
                        : `+${formatMoney(projectInterest(fromApiMoney(goal.balance), goal.interest_rate_bps, 30))}`
                    }
                  />
                  <DetailRow
                    label={t('savings.goal.projectedYear')}
                    value={
                      hidden
                        ? t('common.masked')
                        : `+${formatMoney(projectInterest(fromApiMoney(goal.balance), goal.interest_rate_bps, 365))}`
                    }
                  />
                  <Text variant="caption" color="textMuted">
                    {t('savings.goal.projectedNote')}
                  </Text>
                </>
              )}
            </View>
          </Card>

          {isOpen && (
            <Card padded={false}>
              <ListItem
                leading={Repeat}
                title={t('savings.autoSave.title')}
                subtitle={
                  goal.auto_save
                    ? t('savings.autoSave.fromNaira', {
                        rule: describeAutoSave(
                          formatMoney(fromApiMoney(goal.auto_save.amount), { trimZeroMinor: true }),
                          goal.auto_save.frequency,
                        ),
                      })
                    : t('savings.autoSave.off')
                }
                onPress={() => setEditingAutoSave(true)}
                accessibilityHint={t('savings.autoSave.hint')}
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
              label={t('savings.goal.close')}
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
        title={t('savings.goal.closeTitle', { name: goal?.name ?? t('savings.goal.thisGoal') })}
        message={
          balance && balance.amount > 0n
            ? t('savings.goal.closeWithMoney', { amount: formatMoney(balance) })
            : t('savings.goal.closeEmpty')
        }
        confirmLabel={t('savings.goal.close')}
        cancelLabel={t('common.keepIt')}
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
                setCloseError(t('savings.goal.closeFailed'));
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
