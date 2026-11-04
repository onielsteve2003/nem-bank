import type { Schema } from '@nem/contracts';
import { negate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Clock, Receipt } from '@/components/icons';
import { useTranslation } from 'react-i18next';
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
import { usePageSize } from '@/lib/lowData';
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
  const { t } = useTranslation();
  const pageSize = usePageSize(20);
  const payments = useRepoQuery(
    'cards',
    'listTransactions',
    { path: { card_id: card.id }, query: { limit: pageSize } },
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
        <SectionHeader title={t('cards.payments.title')} />
      </View>
      {payments.isError ? (
        <ErrorState title={t('cards.payments.failed')} onRetry={() => payments.refetch()} />
      ) : !payments.data ? (
        <View style={{ paddingHorizontal: spacing[2] }}>
          <SkeletonGroup accessibilityLabel={t('cards.payments.loading')}>
            <Skeleton height={48} />
            <Skeleton height={48} />
          </SkeletonGroup>
        </View>
      ) : pending.length + done.length === 0 ? (
        <Text color="textMuted" style={{ paddingHorizontal: spacing[2] }}>
          {t('cards.payments.empty')}
        </Text>
      ) : (
        <>
          {pending.length > 0 && (
            <>
              <Text variant="label" style={{ paddingHorizontal: spacing[2] }}>
                {t('cards.payments.pending')}
              </Text>
              <Text variant="caption" color="textMuted" style={{ paddingHorizontal: spacing[2] }}>
                {t('cards.payments.pendingHelp')}
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
                {t('cards.payments.settled')}
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
  const { t } = useTranslation();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const pending = p.status === 'authorized';
  const when = formatWhen(pending ? p.authorized_at : (p.settled_at ?? p.authorized_at));
  return (
    <ListItem
      leading={pending ? Clock : Receipt}
      title={p.merchant.name}
      subtitle={pending ? t('cards.payments.authorised', { when }) : when}
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
            label={t(pending ? 'cards.payments.pending' : 'cards.payments.paid')}
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
