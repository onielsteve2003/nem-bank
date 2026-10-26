import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { CircleCheck, CircleX, Clock } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { categoryMeta, CUSTOMER_LABEL, shortDate } from '../bills';

type Status = Schema<'BillPayment'>['status'];

const HEADLINE: Record<Status, string> = {
  completed: 'Payment successful',
  processing: 'Payment processing',
  failed: 'Payment failed',
  reversed: 'Payment reversed',
};

/** What a bill payment bought, for whom, and how it went (BILL-1, BILL-2). */
export function BillReceiptScreen({ id }: { id: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const payment = useRepoQuery('bills', 'getPayment', { path: { payment_id: id } });
  const p = payment.data;

  return (
    <Screen
      header={<SendHeader title="Receipt" />}
      edges={['top', 'bottom']}
      footer={<Button label="Done" onPress={() => router.dismissTo('/bills')} />}
    >
      {payment.isError ? (
        <ErrorState title="We couldn't load this payment" onRetry={() => payment.refetch()} />
      ) : !p ? (
        <SkeletonGroup accessibilityLabel="Loading receipt">
          <Skeleton height={120} />
          <Skeleton height={180} />
        </SkeletonGroup>
      ) : (
        <>
          <View style={[styles.hero, { gap: spacing[2] }]} accessibilityRole="header">
            <Icon
              icon={
                p.status === 'completed' ? CircleCheck : p.status === 'processing' ? Clock : CircleX
              }
              size="xl"
              color={
                p.status === 'completed'
                  ? 'success'
                  : p.status === 'processing'
                    ? 'warning'
                    : 'danger'
              }
            />
            <Text variant="h2">{HEADLINE[p.status]}</Text>
            <Text variant="display">{formatMoney(fromApiMoney(p.amount))}</Text>
          </View>
          <Card padded={false}>
            <ListItem
              leading={categoryMeta(p.category).icon}
              title={p.biller_name}
              subtitle={p.product_name ?? categoryMeta(p.category).label}
            />
            <ListItem title={CUSTOMER_LABEL[p.category]} subtitle={p.customer_id} />
            <ListItem title="Reference" subtitle={p.reference} />
            <ListItem title="Date" subtitle={shortDate(p.created_at)} />
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: 16 },
});
