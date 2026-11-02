import { Truck } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  BankCard,
  Button,
  Card,
  ErrorState,
  PaidFeatureNotice,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { isApiError } from '@/data';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { addressComplete, toApiAddress, type DeliveryAddress } from '../cards';
import { AddressFields } from '../components/AddressFields';

/**
 * Order a physical card (CARD-8), designed in full: what it is, where to post
 * it and what it costs. Printing and posting needs a card partner, so the bank
 * answers with the Paid Feature Notice instead of pretending it is on its way.
 */
export function PhysicalCardScreen() {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const accounts = useRepoQuery('accounts', 'list');
  const me = useRepoQuery('users', 'getMe');
  const order = useRepoMutation('cards', 'requestPhysical', { invalidates: [] });
  const [address, setAddress] = useState<DeliveryAddress>({
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
  });
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [error, setError] = useState<string>();

  const header = <SendHeader title={t('cards.physical.title')} first />;
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const holder = me.data ? `${me.data.first_name} ${me.data.last_name}` : t('cards.new.yourName');

  const submit = () => {
    if (!naira || !addressComplete(address)) return;
    setError(undefined);
    order.mutate(
      {
        body: {
          account_id: naira.id,
          delivery_address: toApiAddress(address),
        },
      },
      {
        onError: (e) => {
          if (isApiError(e) && e.code === 'paid_feature_required') setNoticeOpen(true);
          else
            setError(
              isApiError(e) ? (e.problem.detail ?? e.problem.title) : t('common.tryAgainMoment'),
            );
        },
      },
    );
  };

  if (accounts.isError) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <ErrorState title={t('common.accountFailed')} onRetry={() => accounts.refetch()} />
      </Screen>
    );
  }
  if (!accounts.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel={t('common.loading')}>
          <Skeleton height={200} radius={16} />
          <Skeleton height={56} />
        </SkeletonGroup>
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {error && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          <Button
            label={t('cards.physical.order')}
            icon={Truck}
            disabled={!naira || !addressComplete(address)}
            loading={order.isPending}
            onPress={submit}
          />
        </View>
      }
    >
      <BankCard
        holder={holder}
        last4="••••"
        expiry="••/••"
        network="verve"
        kind="physical"
        design="noir"
        tilt={false}
      />

      <Card>
        <View style={{ gap: spacing[2] }}>
          {t('cards.physical.whatYouGet', { returnObjects: true }).map((line) => (
            <Text key={line}>{`•  ${line}`}</Text>
          ))}
        </View>
      </Card>

      <SectionHeader title={t('cards.physical.deliverTo')} />
      <AddressFields value={address} onChange={setAddress} />

      <Card>
        <View style={{ gap: spacing[2] }}>
          <View style={styles.between}>
            <Text color="textMuted">{t('cards.physical.cardAndDelivery')}</Text>
            <Text>₦1,000.00</Text>
          </View>
          <View style={styles.between}>
            <Text color="textMuted">{t('cards.physical.paidFrom')}</Text>
            <Text>{t('cards.physical.ngnAccount')}</Text>
          </View>
          <Text variant="caption" color="textMuted">
            {t('cards.physical.chargedWhenPosted')}
          </Text>
        </View>
      </Card>

      <PaidFeatureNotice
        open={noticeOpen}
        onClose={() => setNoticeOpen(false)}
        feature="physicalCard"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
});
