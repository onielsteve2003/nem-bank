import { formatMoney } from '@nem/shared';
import { CircleCheck } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  Card,
  DemoMoneyBadge,
  ErrorState,
  Icon,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { DetailRow } from '@/features/savings/components/DetailRow';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { InstallmentList } from '../components/InstallmentList';
import { LoanSummary } from '../components/LoanSummary';
import { aprLabel, tenorLabel } from '../credit';

const paidOut = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Lagos',
});

type Props = {
  id: string;
  /** Opened straight after accepting an offer: say where the money went. */
  justBorrowed?: boolean;
};

/**
 * One loan (CRD-3): what is left, the next payment, the terms and the full
 * repayment schedule with each instalment's state.
 */
export function LoanScreen({ id, justBorrowed = false }: Props) {
  const { spacing } = useTheme();
  const query = useRepoQuery('credit', 'getLoan', { path: { loan_id: id } });
  const loan = query.data;

  let body;
  if (query.isError) {
    body = <ErrorState title="We couldn't load this loan" onRetry={() => query.refetch()} />;
  } else if (!loan) {
    body = (
      <SkeletonGroup accessibilityLabel="Loading your loan">
        <Skeleton height={180} />
        <Skeleton height={240} />
      </SkeletonGroup>
    );
  } else {
    const principal = formatMoney(fromApiMoney(loan.principal));
    body = (
      <>
        {justBorrowed && (
          <Card>
            <View
              style={[styles.row, { gap: spacing[3] }]}
              accessible
              accessibilityRole="alert"
              accessibilityLabel={`${principal} is in your naira account`}
            >
              <Icon icon={CircleCheck} color="success" />
              <Text variant="bodyStrong" style={styles.flex}>
                {principal} is in your naira account
              </Text>
            </View>
          </Card>
        )}
        <LoanSummary loan={loan} />
        <Card>
          <View style={{ gap: spacing[3] }}>
            <DetailRow label="Borrowed" value={principal} />
            <DetailRow label="APR" value={`${aprLabel(loan.apr_bps)} a year`} />
            <DetailRow label="Term" value={tenorLabel(loan.tenor_days)} />
            <DetailRow label="Paid out on" value={paidOut.format(new Date(loan.disbursed_at))} />
            <DetailRow label="Auto-repay" value={loan.auto_repay ? 'On' : 'Off'} />
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="Repayment schedule" />
          <Card>
            <InstallmentList installments={loan.schedule} showStatus />
          </Card>
        </View>
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Your loan" />}
      edges={['top', 'bottom']}
      onRefresh={() => void query.refetch()}
      refreshing={query.isRefetching}
    >
      <View style={styles.start}>
        <DemoMoneyBadge />
      </View>
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  start: { alignItems: 'flex-start' },
});
