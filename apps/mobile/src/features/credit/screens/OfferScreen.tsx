import { formatMoney, money } from '@nem/shared';
import { useState } from 'react';
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
  const offer = useRepoQuery(
    'credit',
    'createOffer',
    {
      body: {
        amount: toApiMoney(money(amountAt(settledIndex), 'NGN')),
        tenor_days: settledTenor,
      },
    },
    { enabled: steps > 0, staleTime: 5 * 60_000 },
  );
  const o = offer.data;
  const pending = settledIndex !== index || settledTenor !== tenor;

  let body;
  if (check.isError) {
    body = <ErrorState title="We couldn't load your offer" onRetry={() => check.refetch()} />;
  } else if (!check.data) {
    body = (
      <SkeletonGroup accessibilityLabel="Loading your offer">
        <Skeleton height={180} />
        <Skeleton height={220} />
      </SkeletonGroup>
    );
  } else if (steps === 0) {
    body = (
      <ErrorState
        title="You can't borrow right now"
        message="Go back to Credit to see why and what to do next."
      />
    );
  } else {
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[4] }}>
            <View style={{ gap: spacing[1] }}>
              <Text variant="bodySmall" color="textMuted">
                Borrow
              </Text>
              <MoneyText
                value={money(amountAt(index), 'NGN')}
                variant="amountLarge"
                trimZeroMinor
                label="Borrow"
              />
            </View>
            <Slider
              label="Amount to borrow"
              value={index}
              steps={steps}
              onChange={setAmountIndex}
              valueText={naira(amountAt(index))}
              minLabel={naira(amountAt(0))}
              maxLabel={naira(max)}
            />
            <View style={{ gap: spacing[1] }}>
              <Text variant="bodySmall" color="textMuted">
                Repay over
              </Text>
              <Text variant="h2">{tenorLabel(tenor)}</Text>
            </View>
            <Slider
              label="Repay over"
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
          <ErrorState title="We couldn't price this loan" onRetry={() => offer.refetch()} />
        ) : !o ? (
          <SkeletonGroup accessibilityLabel="Pricing your loan">
            <Skeleton height={220} />
          </SkeletonGroup>
        ) : (
          <View style={{ gap: spacing[4], opacity: pending ? 0.5 : 1 }}>
            <Card>
              <View style={{ gap: spacing[3] }}>
                <DetailRow label="APR" value={`${aprLabel(o.apr_bps)} a year`} />
                <DetailRow label="Interest" value={formatMoney(fromApiMoney(o.interest))} />
                <DetailRow label="Fee (1%, once)" value={formatMoney(fromApiMoney(o.fees))} />
                <DetailRow
                  label="Total to repay"
                  value={formatMoney(fromApiMoney(o.total_repayment))}
                />
                <Text variant="bodySmall" color="textMuted">
                  {`${o.schedule.length} ${o.schedule.length === 1 ? 'payment' : 'monthly payments'}. You pay ${formatMoney(fromApiMoney(o.total_repayment))} in all for ${formatMoney(fromApiMoney(o.principal))}. No other charges.`}
                </Text>
              </View>
            </Card>
            <View style={{ gap: spacing[2] }}>
              <SectionHeader title="Repayment schedule" />
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
      header={<SendHeader title="Your offer" />}
      edges={['top', 'bottom']}
      footer={
        o && !pending && steps > 0 ? (
          <AcceptOffer offer={o} onExpired={() => void offer.refetch()} />
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
