import type { Schema } from '@nem/contracts';
import { negate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Clock, Receipt } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  ErrorState,
  ListItem,
  MoneyText,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  StatusPill,
  Text,
} from '@/components';
import { formatWhen } from '@/features/transactions/TransactionRow';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { splitCardPayments } from '../cards';

type Payment = Schema<'CardTransaction'>;

export type Props = { card: Schema<'Card'> };

/** How often to look again while a payment is waiting to settle. */
const PENDING_REFRESH_MS = 15_000;

/**
 * A card's payments (CARD-5): pending authorisations, which hold money but have
 * not left yet, apart from settled ones. A settled row opens its transaction.
 */
export function CardPayments({ card }: Props) {
  const router = useRouter();
  const { spacing } = useTheme();
  const payments = useRepoQuery(
    'cards',
    'listTransactions',
    { path: { card_id: card.id }, query: { limit: 20 } },
    {
      refetchInterval: (q) =>
        q.state.data?.data.some((p) => p.status === 'authorized') ? PENDING_REFRESH_MS : false,
    },
  );
  const { pending, done } = splitCardPayments(payments.data?.data ?? []);

  const row = (p: Payment) => (
    <PaymentRow
      key={p.id}
      payment={p}
      onPress={
        p.transaction_id ? () => router.push(`/transactions/${p.transaction_id}`) : undefined
      }
    />
  );

  return (
    <View style={{ gap: spacing[1] }}>
      <View style={{ paddingHorizontal: spacing[2] }}>
        <SectionHeader title="Payments" />
      </View>
      {payments.isError ? (
        <ErrorState
          title="We couldn't load this card's payments"
          onRetry={() => payments.refetch()}
        />
      ) : !payments.data ? (
        <View style={{ paddingHorizontal: spacing[2] }}>
          <SkeletonGroup accessibilityLabel="Loading payments">
            <Skeleton height={48} />
            <Skeleton height={48} />
          </SkeletonGroup>
        </View>
      ) : pending.length + done.length === 0 ? (
        <Text color="textMuted" style={{ paddingHorizontal: spacing[2] }}>
          No payments with this card yet.
        </Text>
      ) : (
        <>
          {pending.length > 0 && (
            <>
              <Text variant="label" style={{ paddingHorizontal: spacing[2] }}>
                Pending
              </Text>
              <Text variant="caption" color="textMuted" style={{ paddingHorizontal: spacing[2] }}>
                Held from your balance until the merchant settles, usually within a few days.
              </Text>
              {pending.map(row)}
            </>
          )}
          {done.length > 0 && (
            <>
              <Text
                variant="label"
                style={{ paddingHorizontal: spacing[2], paddingTop: spacing[2] }}
              >
                Settled
              </Text>
              {done.map(row)}
            </>
          )}
        </>
      )}
    </View>
  );
}

function PaymentRow({ payment: p, onPress }: { payment: Payment; onPress?: () => void }) {
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const pending = p.status === 'authorized';
  const when = formatWhen(pending ? p.authorized_at : (p.settled_at ?? p.authorized_at));
  return (
    <ListItem
      leading={pending ? Clock : Receipt}
      title={p.merchant.name}
      subtitle={pending ? `Authorised ${when}` : when}
      onPress={onPress}
      showChevron={false}
      trailing={
        <View style={styles.trailing}>
          <MoneyText
            value={negate(fromApiMoney(p.billing_amount))}
            variant="bodyStrong"
            color={p.status === 'reversed' ? 'textMuted' : 'text'}
            masked={hidden}
            align="right"
            label={pending ? 'Pending' : 'Paid'}
          />
          {pending ? <StatusPill status="pending" /> : null}
          {p.status === 'reversed' ? <StatusPill status="reversed" /> : null}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  trailing: { alignItems: 'flex-end', gap: 2 },
});
