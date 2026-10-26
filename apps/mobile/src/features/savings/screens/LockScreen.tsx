import { add, formatMoney, subtract } from '@nem/shared';
import { Lock as LockIcon, Unlock } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  MoneyText,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { DetailRow } from '../components/DetailRow';
import { formatGoalDate } from '../goals';
import { keptOnBreak, LOCK_STATUS, lockProgress, ratePct, termLabel } from '../locks';

/**
 * One locked saving (SAV-4, SAV-5): the amount, fixed rate, interest so far and
 * at maturity, and the maturity date. Breaking early first spells out what is
 * kept and what is lost, then asks for the PIN or Face ID.
 */
export function LockScreen({ id }: { id: string }) {
  const { colors, radius, spacing } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const lockQuery = useRepoQuery('savings', 'getLock', { path: { lock_id: id } });
  const [step, setStep] = useState<'disclose' | 'confirm' | null>(null);
  const [error, setError] = useState<string>();
  const breakLock = useMoneyMutation('savings', 'breakLock', {
    invalidates: [['savings'], ['accounts'], ['transactions']],
  });

  const lock = lockQuery.data;
  const mask = (v: string) => (hidden ? '••••' : v);

  const run = async () => {
    setError(undefined);
    try {
      await breakLock.mutateAsync({ path: { lock_id: id } });
      setStep(null);
      return true;
    } catch (e) {
      setError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  if (lockQuery.isError || !lock) {
    return (
      <Screen header={<SendHeader title="Locked savings" />} edges={['top', 'bottom']}>
        {lockQuery.isError ? (
          <ErrorState title="We couldn't load this lock" onRetry={() => lockQuery.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading locked saving">
            <Skeleton height={160} radius={24} />
            <Skeleton height={160} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const principal = fromApiMoney(lock.principal);
  const accrued = fromApiMoney(lock.accrued_interest);
  const kept = keptOnBreak(lock, accrued);
  const lost = subtract(accrued, kept);
  const progress = lockProgress(lock);
  const active = lock.status === 'active';

  return (
    <Screen
      header={<SendHeader title={`Locked for ${termLabel(lock.term_days)}`} />}
      edges={['top', 'bottom']}
      onRefresh={() => void lockQuery.refetch()}
      refreshing={lockQuery.isRefetching}
    >
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
          {LOCK_STATUS[lock.status]}
        </Text>
        <MoneyText value={principal} variant="amountLarge" masked={hidden} label="Locked" />
        {active && (
          <>
            <View
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
              style={{ height: 8, backgroundColor: colors.border, borderRadius: radius.pill }}
            >
              <View
                style={{
                  width: `${progress * 100}%`,
                  height: 8,
                  backgroundColor: colors.primary,
                  borderRadius: radius.pill,
                }}
              />
            </View>
            <Text variant="caption" color="textMuted">
              Matures on {formatGoalDate(lock.maturity_date)}
            </Text>
          </>
        )}
      </View>

      {lock.status === 'matured' && (
        <EmptyState
          icon={LockIcon}
          title="Your lock matured"
          message="Your money and all the interest went back to your naira account."
        />
      )}

      <Card>
        <View style={{ gap: spacing[3] }}>
          <DetailRow label="Rate" value={`${ratePct(lock.rate_bps)} a year, fixed`} />
          <DetailRow label="Started" value={formatGoalDate(lock.start_date)} />
          <DetailRow label="Matures" value={formatGoalDate(lock.maturity_date)} />
          {active && <DetailRow label="Interest so far" value={mask(formatMoney(accrued))} />}
          <DetailRow
            label="Interest at maturity"
            value={mask(formatMoney(fromApiMoney(lock.expected_interest)))}
          />
          {lock.paid_out && (
            <DetailRow label="Paid out" value={mask(formatMoney(fromApiMoney(lock.paid_out)))} />
          )}
        </View>
      </Card>

      {active && (
        <>
          <Text variant="caption" color="textMuted">
            Breaking early keeps your full amount but only{' '}
            {ratePct(10_000 - lock.early_break_penalty_bps)} of the interest earned so far.
          </Text>
          <Button
            label="Break lock early"
            icon={Unlock}
            variant="ghost"
            onPress={() => {
              breakLock.resetIntent();
              setError(undefined);
              setStep('disclose');
            }}
          />
        </>
      )}

      <Dialog
        open={step === 'disclose'}
        title="Break this lock early?"
        message={`You get ${formatMoney(add(principal, kept))} today: your ${formatMoney(principal)} plus ${formatMoney(kept)} interest. You lose ${formatMoney(lost)} of interest earned so far, and give up the ${formatMoney(fromApiMoney(lock.expected_interest))} due at maturity.`}
        confirmLabel="Break lock"
        cancelLabel="Keep it locked"
        destructive
        onCancel={() => setStep(null)}
        onConfirm={() => setStep('confirm')}
      />
      <ConfirmSheet
        open={step === 'confirm'}
        onClose={() => setStep(null)}
        subtitle={`Break lock and get ${formatMoney(add(principal, kept))}`}
        onApproved={run}
        error={error}
      />
    </Screen>
  );
}
