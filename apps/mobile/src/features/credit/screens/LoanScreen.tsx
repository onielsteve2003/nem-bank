import { formatMoney } from '@nem/shared';
import { CircleCheck } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
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
import { LoanActions } from '../components/LoanActions';
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
 * One loan (CRD-3, CRD-4): what is left, the next payment, anything overdue,
 * repaying early or paying off, auto-repay, the terms and the full repayment
 * schedule with each instalment's state.
 */
export function LoanScreen({ id, justBorrowed = false }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const query = useRepoQuery('credit', 'getLoan', { path: { loan_id: id } });
  const loan = query.data;

  let body;
  if (query.isError) {
    body = <ErrorState title={t('credit.loan.failed')} onRetry={() => query.refetch()} />;
  } else if (!loan) {
    body = (
      <SkeletonGroup accessibilityLabel={t('credit.loan.loading')}>
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
              accessibilityLabel={t('credit.loan.inNaira', { amount: principal })}
            >
              <Icon icon={CircleCheck} color="success" />
              <Text variant="bodyStrong" style={styles.flex}>
                {t('credit.loan.inNaira', { amount: principal })}
              </Text>
            </View>
          </Card>
        )}
        <LoanSummary loan={loan} />
        {loan.status !== 'repaid' && <LoanActions loan={loan} />}
        <Card>
          <View style={{ gap: spacing[3] }}>
            <DetailRow label={t('credit.loan.borrowed')} value={principal} />
            <DetailRow
              label={t('credit.loan.apr')}
              value={t('credit.loan.aprYear', { apr: aprLabel(loan.apr_bps) })}
            />
            <DetailRow label={t('credit.loan.term')} value={tenorLabel(loan.tenor_days)} />
            <DetailRow
              label={t('credit.loan.paidOutOn')}
              value={paidOut.format(new Date(loan.disbursed_at))}
            />
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('credit.loan.schedule')} />
          <Card>
            <InstallmentList installments={loan.schedule} showStatus />
          </Card>
        </View>
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('credit.loan.title')} />}
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
