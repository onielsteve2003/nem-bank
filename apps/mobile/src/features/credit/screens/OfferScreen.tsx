import { formatMoney, money } from '@nem/shared';
import { keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  DemoMoneyBadge,
  ErrorState,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Slider,
  Text,
} from '@/components';
import { DetailRow } from '@/features/savings/components/DetailRow';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

import { AcceptOffer } from '../components/AcceptOffer';
import { InstallmentList } from '../components/InstallmentList';
import { amountAt, amountSteps, aprLabel, TENORS, tenorLabel } from '../credit';

const naira = (kobo: bigint) => formatMoney(money(kobo, 'NGN'), { trimZeroMinor: true });

/**
 * Loan offer (CRD-2): pick an amount and how long to repay, and the bank's
 * offer shows the APR, interest, fee and total repayment before anything is
 * borrowed, with the full schedule. Moving a slider asks for a new offer once
 * it settles.
 */
export function OfferScreen() {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const check = useRepoQuery('credit', 'getEligibility');
  const max = check.data?.eligible ? fromApiMoney(check.data.max_amount).amount : 0n;
  const steps = amountSteps(max);
  // Start in the middle of what they may borrow, over three months.
  const [amountIndex, setAmountIndex] = useState<number>();
  const [tenorIndex, setTenorIndex] = useState(2);
  const index = amountIndex ?? Math.max(0, Math.floor((steps - 1) / 2));
  const tenor = TENORS[tenorIndex]!;
  const settledIndex = useDebounced(index, 300);
  const settledTenor = useDebounced(tenor, 300);
  // Only price what the sliders settled on; the last offer stays (dimmed) meanwhile.
  const pending = settledIndex !== index || settledTenor !== tenor;
  const offer = useRepoQuery(
    'credit',
    'createOffer',
    {
      body: {
        amount: toApiMoney(money(amountAt(settledIndex), 'NGN')),
        tenor_days: settledTenor,
      },
    },
    { enabled: steps > 0 && !pending, staleTime: 5 * 60_000, placeholderData: keepPreviousData },
  );
  const o = offer.data;
  const pricing = pending || offer.isPlaceholderData;

  let body;
  if (check.isError) {
    body = <ErrorState title={t('credit.offer.failed')} onRetry={() => check.refetch()} />;
  } else if (!check.data) {
    body = (
      <SkeletonGroup accessibilityLabel={t('credit.offer.loading')}>
        <Skeleton height={180} />
        <Skeleton height={220} />
      </SkeletonGroup>
    );
  } else if (steps === 0) {
    body = (
      <ErrorState title={t('credit.offer.cannotTitle')} message={t('credit.offer.cannotMessage')} />
    );
  } else {
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[4] }}>
            <View style={{ gap: spacing[1] }}>
              <Text variant="bodySmall" color="textMuted">
                {t('credit.offer.borrow')}
              </Text>
              <MoneyText
                value={money(amountAt(index), 'NGN')}
                variant="amountLarge"
                trimZeroMinor
                label={t('credit.offer.borrow')}
              />
            </View>
            <Slider
              label={t('credit.offer.amountSlider')}
              value={index}
              steps={steps}
              onChange={setAmountIndex}
              valueText={naira(amountAt(index))}
              minLabel={naira(amountAt(0))}
              maxLabel={naira(max)}
            />
            <View style={{ gap: spacing[1] }}>
              <Text variant="bodySmall" color="textMuted">
                {t('credit.offer.repayOver')}
              </Text>
              <Text variant="h2">{tenorLabel(tenor)}</Text>
            </View>
            <Slider
              label={t('credit.offer.repayOver')}
              value={tenorIndex}
              steps={TENORS.length}
              onChange={setTenorIndex}
              valueText={tenorLabel(tenor)}
              minLabel={tenorLabel(TENORS[0])}
              maxLabel={tenorLabel(TENORS[TENORS.length - 1]!)}
            />
          </View>
        </Card>

        {offer.isError ? (
          <ErrorState title={t('credit.offer.priceFailed')} onRetry={() => offer.refetch()} />
        ) : !o ? (
          <SkeletonGroup accessibilityLabel={t('credit.offer.pricing')}>
            <Skeleton height={220} />
          </SkeletonGroup>
        ) : (
          <View style={{ gap: spacing[4], opacity: pricing ? 0.5 : 1 }}>
            <Card>
              <View style={{ gap: spacing[3] }}>
                <DetailRow
                  label={t('credit.loan.apr')}
                  value={t('credit.loan.aprYear', { apr: aprLabel(o.apr_bps) })}
                />
                <DetailRow
                  label={t('credit.offer.interest')}
                  value={formatMoney(fromApiMoney(o.interest))}
                />
                <DetailRow
                  label={t('credit.offer.fee')}
                  value={formatMoney(fromApiMoney(o.fees))}
                />
                <DetailRow
                  label={t('credit.offer.total')}
                  value={formatMoney(fromApiMoney(o.total_repayment))}
                />
                <Text variant="bodySmall" color="textMuted">
                  {t('credit.offer.payments', {
                    count: o.schedule.length,
                    total: formatMoney(fromApiMoney(o.total_repayment)),
                    principal: formatMoney(fromApiMoney(o.principal)),
                  })}
                </Text>
              </View>
            </Card>
            <View style={{ gap: spacing[2] }}>
              <SectionHeader title={t('credit.loan.schedule')} />
              <Card>
                <InstallmentList installments={o.schedule} />
              </Card>
            </View>
          </View>
        )}
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('credit.offer.title')} />}
      edges={['top', 'bottom']}
      footer={
        o && steps > 0 ? (
          <AcceptOffer offer={o} pricing={pricing} onExpired={() => void offer.refetch()} />
        ) : undefined
      }
    >
      <View style={styles.start}>
        <DemoMoneyBadge />
      </View>
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  start: { alignItems: 'flex-start' },
});
