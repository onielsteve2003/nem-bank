import { Truck } from 'lucide-react-native';
import { useState } from 'react';
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

const WHAT_YOU_GET = [
  'A Verve debit card on your NGN account, with your name printed on it',
  'Contactless and chip and PIN at shops and ATMs',
  'The same freeze, limit and channel controls as your virtual cards',
  'Delivered in 5 to 7 working days; activate it in the app with your PIN',
];

/**
 * Order a physical card (CARD-8), designed in full: what it is, where to post
 * it and what it costs. Printing and posting needs a card partner, so the bank
 * answers with the Paid Feature Notice instead of pretending it is on its way.
 */
export function PhysicalCardScreen() {
  const { spacing } = useTheme();
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

  const header = <SendHeader title="Physical card" first />;
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const holder = me.data ? `${me.data.first_name} ${me.data.last_name}` : 'Your name';

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
              isApiError(e) ? (e.problem.detail ?? e.problem.title) : 'Try again in a moment.',
            );
        },
      },
    );
  };

  if (accounts.isError) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <ErrorState title="We couldn't load your account" onRetry={() => accounts.refetch()} />
      </Screen>
    );
  }
  if (!accounts.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel="Loading">
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
            label="Order card · ₦1,000"
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
          {WHAT_YOU_GET.map((line) => (
            <Text key={line}>{`•  ${line}`}</Text>
          ))}
        </View>
      </Card>

      <SectionHeader title="Deliver to" />
      <AddressFields value={address} onChange={setAddress} />

      <Card>
        <View style={{ gap: spacing[2] }}>
          <View style={styles.between}>
            <Text color="textMuted">Card and delivery</Text>
            <Text>₦1,000.00</Text>
          </View>
          <View style={styles.between}>
            <Text color="textMuted">Paid from</Text>
            <Text>NGN account</Text>
          </View>
          <Text variant="caption" color="textMuted">
            Charged only once the card is posted.
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
