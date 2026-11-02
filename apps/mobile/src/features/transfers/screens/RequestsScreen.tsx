import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleCheck, HandCoins, Inbox, Send } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
} from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ConfirmSheet } from '../components/ConfirmSheet';
import { RequestSheet } from '../components/RequestSheet';
import { SendHeader } from '../components/SendHeader';
import { sendErrorMessage } from '../confirm';
import {
  counterpartOf,
  openCount,
  REQUEST_STATUS,
  requestSubtitle,
  sortRequests,
} from '../requests';
import { useTranslation } from 'react-i18next';

type MoneyRequest = Schema<'MoneyRequest'>;
type Tab = 'incoming' | 'outgoing';

function RequestRow({
  request,
  onPress,
}: {
  request: MoneyRequest;
  onPress: (r: MoneyRequest) => void;
}) {
  const other = counterpartOf(request);
  const amount = formatMoney(fromApiMoney(request.amount));
  const subtitle = requestSubtitle(request);
  const status = REQUEST_STATUS[request.status];
  const { t } = useTranslation();
  return (
    <ListItem
      leading={<Avatar name={other.name} size="md" ring />}
      title={other.name}
      subtitle={subtitle}
      trailing={
        <View style={styles.trailing}>
          <Text variant="bodyStrong">{amount}</Text>
          {request.status !== 'pending' && <Badge label={status.label} tone={status.tone} />}
        </View>
      }
      onPress={() => onPress(request)}
      accessibilityLabel={`${other.name}, ${amount}, ${subtitle}`}
      accessibilityHint={
        request.status === 'pending' && request.direction === 'incoming'
          ? t('transfers.requestsScreen.payOrDecline')
          : t('transfers.requestsScreen.show')
      }
    />
  );
}

/**
 * Money requests (TRF-10): what people have asked the customer to pay, and what
 * the customer has asked for. Incoming requests are paid with the PIN like any
 * transfer, once, however many times the button is tapped.
 */
export function RequestsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ tab?: string; created?: string }>();
  const { spacing } = useTheme();
  const [tab, setTab] = useState<Tab>(params.tab === 'sent' ? 'outgoing' : 'incoming');
  const [chosen, setChosen] = useState<MoneyRequest | null>(null);
  const [paying, setPaying] = useState<MoneyRequest | null>(null);
  const [payError, setPayError] = useState<string>();
  const { t } = useTranslation();

  const incoming = useRepoQuery('moneyRequests', 'list', {
    query: { direction: 'incoming', limit: 50 },
  });
  const outgoing = useRepoQuery('moneyRequests', 'list', {
    query: { direction: 'outgoing', limit: 50 },
  });
  const accounts = useRepoQuery('accounts', 'list');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');
  const pay = useMoneyMutation('moneyRequests', 'pay', {
    invalidates: [['moneyRequests'], ['accounts'], ['transactions'], ['transfers']],
  });

  const current = tab === 'incoming' ? incoming : outgoing;
  const list = current.data ? sortRequests(current.data.data) : undefined;
  const toPay = openCount(incoming.data?.data);
  const justSent = params.created
    ? outgoing.data?.data.find((r) => r.id === params.created)
    : undefined;

  const onApproved = useCallback(async () => {
    if (!paying || !source) return false;
    setPayError(undefined);
    try {
      const transfer = await pay.mutateAsync({
        path: { request_id: paying.id },
        body: { source_account_id: source.id },
      });
      setPaying(null);
      router.push({ pathname: '/send/result/[id]', params: { id: transfer.id } });
      return true;
    } catch (e) {
      setPayError(sendErrorMessage(e as Error).message);
      return false;
    }
  }, [paying, source, pay, router]);

  return (
    <Screen
      header={<SendHeader title={t('transfers.requestsScreen.title')} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={t('transfers.requestMoney.title')}
          icon={HandCoins}
          variant="secondary"
          onPress={() => router.push('/send/request')}
        />
      }
    >
      <View accessibilityRole="tablist" style={[styles.row, { gap: spacing[2] }]}>
        <Chip
          label={
            toPay > 0
              ? t('transfers.requestsScreen.toPayCount', { count: toPay })
              : t('transfers.requestsScreen.toPay')
          }
          icon={Inbox}
          selected={tab === 'incoming'}
          onPress={() => setTab('incoming')}
        />
        <Chip
          label={t('transfers.requestsScreen.sent')}
          icon={Send}
          selected={tab === 'outgoing'}
          onPress={() => setTab('outgoing')}
        />
      </View>

      {tab === 'outgoing' && justSent && justSent.status === 'pending' && (
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Icon icon={CircleCheck} color="success" />
            <Text style={styles.flex} accessibilityLiveRegion="polite">
              {t('transfers.requestsScreen.justSent', { name: justSent.payer.name.split(' ')[0] })}
            </Text>
          </View>
        </Card>
      )}

      {list ? (
        list.length === 0 ? (
          tab === 'incoming' ? (
            <EmptyState
              icon={Inbox}
              title={t('transfers.requestsScreen.nothing')}
              message={t('transfers.requestsScreen.nothingMessage')}
            />
          ) : (
            <EmptyState
              icon={HandCoins}
              title={t('transfers.requestsScreen.none')}
              message={t('transfers.requestsScreen.noneMessage')}
              actionLabel={t('transfers.requestMoney.title')}
              onAction={() => router.push('/send/request')}
            />
          )
        ) : (
          <Card padded={false}>
            {list.map((r) => (
              <RequestRow key={r.id} request={r} onPress={setChosen} />
            ))}
          </Card>
        )
      ) : current.isError ? (
        <ErrorState
          title={t('transfers.requestsScreen.failed')}
          onRetry={() => current.refetch()}
        />
      ) : (
        <SkeletonGroup accessibilityLabel={t('transfers.requestsScreen.loading')}>
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}

      {chosen && (
        <RequestSheet
          key={chosen.id}
          request={chosen}
          onClose={() => setChosen(null)}
          onPay={(r) => {
            setChosen(null);
            setPayError(undefined);
            pay.resetIntent();
            setPaying(r);
          }}
        />
      )}
      <ConfirmSheet
        open={paying !== null}
        onClose={() => setPaying(null)}
        subtitle={
          paying
            ? t('common.payAmountTo', {
                amount: formatMoney(fromApiMoney(paying.amount)),
                name: paying.requester.name.split(' ')[0],
              })
            : ''
        }
        onApproved={onApproved}
        error={payError}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  trailing: { alignItems: 'flex-end', gap: 4 },
  flex: { flex: 1 },
});
