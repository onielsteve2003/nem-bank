import { formatMoney } from '@nem/shared';
import { useLocalSearchParams } from 'expo-router';
import { Eye, Plus, Receipt, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { transactionTitle } from '@/features/transactions/TransactionRow';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { usePageSize } from '@/lib/lowData';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useKidGoalsStore, type KidGoal } from '@/stores/kidGoals';
import { useTheme } from '@/theme';

import {
  goalPercent,
  KID_GOAL_EMOJIS,
  KID_GOAL_PRESETS,
  nairaText,
  spendLeftToday,
} from '../family';

const NO_GOALS: KidGoal[] = [];

/**
 * Kid mode (FAM-1): the simpler app a child sees. Big balance, what's left to
 * spend today, what they're saving for, and their last few payments in plain
 * words. Parents open it from the child's page to see exactly what they see.
 */
export function KidHomeScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const path = { dependant_id: id };
  const pageSize = usePageSize(20);
  const q = useRepoQuery('family', 'getDependant', { path });
  const activity = useRepoQuery('family', 'listActivity', { path, query: { limit: pageSize } });
  const goals = useKidGoalsStore((s) => s.goals[id] ?? NO_GOALS);
  const addGoal = useKidGoalsStore((s) => s.addGoal);
  const removeGoal = useKidGoalsStore((s) => s.removeGoal);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(KID_GOAL_EMOJIS[0]!);
  const [target, setTarget] = useState(KID_GOAL_PRESETS[1]!);

  const header = <SendHeader title={t('common.kidMode')} />;
  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title={t('family.kid.failed')} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('family.kid.loading')}>
            <Skeleton height={180} />
            <Skeleton height={120} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const child = q.data;
  const first = child.profile.name.split(' ')[0];
  const balance = fromApiMoney(child.balance);
  const transactions = activity.data?.data ?? [];
  const left = spendLeftToday(child.controls, transactions, new Date());

  const save = () => {
    addGoal(id, { name: name.trim(), emoji, targetMinor: target.amount.toString() });
    setName('');
    setAdding(false);
  };

  return (
    <Screen header={header} edges={['top', 'bottom']}>
      <View
        style={[
          styles.row,
          { gap: spacing[2], padding: spacing[3], borderRadius: radius.md },
          { backgroundColor: colors.raised },
        ]}
      >
        <Eye size={16} color={colors.textMuted} />
        <Text variant="bodySmall" color="textMuted" style={styles.flex}>
          {t('family.kid.sees', { name: first })}
        </Text>
      </View>

      <Card>
        <View style={[styles.center, { gap: spacing[2] }]}>
          <Text variant="h2" accessibilityRole="header">
            {t('family.kid.hi', { name: first })}
          </Text>
          <Text variant="bodySmall" color="textMuted">
            {t('family.kid.youHave')}
          </Text>
          <MoneyText value={balance} variant="amountLarge" trimZeroMinor />
          <Text variant="body" color={child.controls.paused ? 'warning' : 'textMuted'}>
            {child.controls.paused
              ? t('family.kid.paused')
              : t('family.kid.left', { amount: formatMoney(left, { trimZeroMinor: true }) })}
          </Text>
        </View>
      </Card>

      <SectionHeader title={t('family.kid.savingFor')} />
      {goals.map((g) => {
        const targetMoney = { amount_minor: g.targetMinor, currency: 'NGN' as const };
        const pct = goalPercent(balance.amount, BigInt(g.targetMinor));
        return (
          <Card key={g.id}>
            <View style={{ gap: spacing[2] }}>
              <View style={[styles.row, { gap: spacing[3] }]}>
                <Text variant="h2">{g.emoji}</Text>
                <View style={styles.flex}>
                  <Text variant="bodyStrong">{g.name}</Text>
                  <Text variant="bodySmall" color="textMuted">
                    {pct >= 100
                      ? t('family.kid.enough')
                      : t('family.kid.pctOf', { pct, amount: nairaText(targetMoney) })}
                  </Text>
                </View>
                <IconButton
                  icon={Trash2}
                  accessibilityLabel={t('common.removeName', { name: g.name })}
                  onPress={() => removeGoal(id, g.id)}
                />
              </View>
              <View
                accessibilityRole="progressbar"
                accessibilityLabel={t('family.kid.progress', { name: g.name })}
                accessibilityValue={{ min: 0, max: 100, now: pct }}
                style={[
                  styles.track,
                  { backgroundColor: colors.border, borderRadius: radius.pill },
                ]}
              >
                <View
                  style={[
                    styles.fill,
                    {
                      width: `${pct}%`,
                      borderRadius: radius.pill,
                      backgroundColor: pct >= 100 ? colors.success : colors.primary,
                    },
                  ]}
                />
              </View>
            </View>
          </Card>
        );
      })}
      {adding ? (
        <Card>
          <View style={{ gap: spacing[3] }}>
            <TextField
              label={t('family.kid.goalName')}
              value={name}
              onChangeText={setName}
              maxLength={30}
            />
            <View style={[styles.wrap, { gap: spacing[2] }]}>
              {KID_GOAL_EMOJIS.map((e) => (
                <Chip key={e} label={e} selected={emoji === e} onPress={() => setEmoji(e)} />
              ))}
            </View>
            <View style={[styles.wrap, { gap: spacing[2] }]}>
              {KID_GOAL_PRESETS.map((m) => (
                <Chip
                  key={m.amount.toString()}
                  label={nairaText(toApiMoney(m))}
                  selected={target.amount === m.amount}
                  onPress={() => setTarget(m)}
                />
              ))}
            </View>
            <Button label={t('family.kid.saveGoal')} disabled={!name.trim()} onPress={save} />
          </View>
        </Card>
      ) : (
        <Button
          label={t(goals.length ? 'family.kid.addAnother' : 'family.kid.addGoal')}
          icon={Plus}
          variant="secondary"
          fullWidth
          onPress={() => setAdding(true)}
        />
      )}

      <SectionHeader title={t('family.kid.recently')} />
      {activity.isError ? (
        <ErrorState title={t('family.kid.paymentsFailed')} onRetry={() => activity.refetch()} />
      ) : !activity.data ? (
        <Skeleton height={120} />
      ) : transactions.length ? (
        <Card>
          <View style={{ gap: spacing[3] }}>
            {transactions.slice(0, 5).map((tx) => (
              <View key={tx.id} style={[styles.row, { gap: spacing[3] }]}>
                <Text variant="h3">{tx.direction === 'credit' ? '💰' : '🛍️'}</Text>
                <Text variant="body" style={styles.flex}>
                  {t(tx.direction === 'credit' ? 'family.kid.gotMoney' : 'family.kid.spent', {
                    title: transactionTitle(tx),
                  })}
                </Text>
                <MoneyText value={fromApiMoney(tx.amount)} variant="bodyStrong" trimZeroMinor />
              </View>
            ))}
          </View>
        </Card>
      ) : (
        <EmptyState
          icon={Receipt}
          title={t('family.kid.noPayments')}
          message={t('family.kid.noPaymentsMessage')}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  track: { height: 10, overflow: 'hidden' },
  fill: { height: '100%' },
});
