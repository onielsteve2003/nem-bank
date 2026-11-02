import { add, formatMoney, subtract } from '@nem/shared';
import { Lock as LockIcon, Unlock } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const lockQuery = useRepoQuery('savings', 'getLock', { path: { lock_id: id } });
  const [step, setStep] = useState<'disclose' | 'confirm' | null>(null);
  const [error, setError] = useState<string>();
  const breakLock = useMoneyMutation('savings', 'breakLock', {
    invalidates: [['savings'], ['accounts'], ['transactions']],
  });

  const lock = lockQuery.data;
  const mask = (v: string) => (hidden ? t('common.masked') : v);

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
      <Screen header={<SendHeader title={t('savings.locks.title')} />} edges={['top', 'bottom']}>
        {lockQuery.isError ? (
          <ErrorState title={t('savings.locks.failed')} onRetry={() => lockQuery.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('savings.locks.loading')}>
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
      header={
        <SendHeader title={t('savings.locks.lockedFor', { term: termLabel(lock.term_days) })} />
      }
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
        <MoneyText
          value={principal}
          variant="amountLarge"
          masked={hidden}
          label={t('savings.locks.locked')}
        />
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
              {t('savings.locks.maturesOn', { date: formatGoalDate(lock.maturity_date) })}
            </Text>
          </>
        )}
      </View>

      {lock.status === 'matured' && (
        <EmptyState
          icon={LockIcon}
          title={t('savings.locks.maturedTitle')}
          message={t('savings.locks.maturedMessage')}
        />
      )}

      <Card>
        <View style={{ gap: spacing[3] }}>
          <DetailRow
            label={t('savings.locks.rate')}
            value={t('savings.locks.rateFixed', { rate: ratePct(lock.rate_bps) })}
          />
          <DetailRow label={t('savings.locks.started')} value={formatGoalDate(lock.start_date)} />
          <DetailRow
            label={t('savings.locks.matures')}
            value={formatGoalDate(lock.maturity_date)}
          />
          {active && (
            <DetailRow
              label={t('savings.locks.interestSoFar')}
              value={mask(formatMoney(accrued))}
            />
          )}
          <DetailRow
            label={t('savings.locks.interestAtMaturity')}
            value={mask(formatMoney(fromApiMoney(lock.expected_interest)))}
          />
          {lock.paid_out && (
            <DetailRow
              label={t('savings.locks.paidOut')}
              value={mask(formatMoney(fromApiMoney(lock.paid_out)))}
            />
          )}
        </View>
      </Card>

      {active && (
        <>
          <Text variant="caption" color="textMuted">
            {t('savings.locks.breakNote', {
              rate: ratePct(10_000 - lock.early_break_penalty_bps),
            })}
          </Text>
          <Button
            label={t('savings.locks.break')}
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
        title={t('savings.locks.breakTitle')}
        message={t('savings.locks.breakMessage', {
          total: formatMoney(add(principal, kept)),
          principal: formatMoney(principal),
          kept: formatMoney(kept),
          lost: formatMoney(lost),
          expected: formatMoney(fromApiMoney(lock.expected_interest)),
        })}
        confirmLabel={t('savings.locks.breakConfirm')}
        cancelLabel={t('savings.locks.keepLocked')}
        destructive
        onCancel={() => setStep(null)}
        onConfirm={() => setStep('confirm')}
      />
      <ConfirmSheet
        open={step === 'confirm'}
        onClose={() => setStep(null)}
        subtitle={t('savings.locks.breakStep', { amount: formatMoney(add(principal, kept)) })}
        onApproved={run}
        error={error}
      />
    </Screen>
  );
}
