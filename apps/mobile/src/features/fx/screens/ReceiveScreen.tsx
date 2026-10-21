import { CURRENCIES, type CurrencyCode } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeftRight, Globe, Share2 } from 'lucide-react-native';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  Chip,
  EmptyState,
  ErrorState,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { AddWalletSheet } from '@/features/accounts/AddWalletSheet';
import { ReceivingDetailsCard } from '@/features/accounts/ReceivingDetailsCard';
import { shareMessage } from '@/features/accounts/receivingDetails';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { env } from '@/lib/env';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ReceiveGuideCard } from '../components/ReceiveGuideCard';
import { RecentInbound } from '../components/RecentInbound';
import { SimulateInbound } from '../components/SimulateInbound';
import { isForeignScheme, RECEIVE_GUIDES } from '../receive';

/**
 * Receive money from abroad (FX-3): each foreign wallet's local details, how a
 * payment reaches it and what it costs, what has come in so far and, in the
 * demo, a payment that lands on demand.
 */
export function ReceiveScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const params = useLocalSearchParams<{ currency?: string; entry?: string }>();
  const accounts = useRepoQuery('accounts', 'list');
  const me = useRepoQuery('users', 'getMe');
  const [currency, setCurrency] = useState(params.currency as CurrencyCode | undefined);
  const [adding, setAdding] = useState(false);

  // Opened from a wallet's details it is the first screen of the modal; from Convert, a step.
  const header = <SendHeader title="Receive from abroad" first={params.entry === 'wallet'} />;
  const foreign = (accounts.data?.data ?? []).filter((a) => a.currency !== 'NGN');
  const wallet = foreign.find((a) => a.currency === currency) ?? foreign[0];

  if (accounts.isError) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <ErrorState title="We couldn't load your wallets" onRetry={() => accounts.refetch()} />
      </Screen>
    );
  }

  if (!accounts.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel="Loading your wallets">
          <Skeleton height={40} />
          <Skeleton height={180} />
          <Skeleton height={220} />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (!wallet) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Globe}
          title="Open a foreign wallet"
          message="A USD, GBP or EUR wallet comes with its own local details, so people abroad can pay you like any local account."
          actionLabel="Add a wallet"
          onAction={() => setAdding(true)}
        />
        {adding && (
          <AddWalletSheet
            open
            accounts={accounts.data.data}
            tier={me.data?.kyc_tier}
            onClose={() => setAdding(false)}
            onOpened={(account) => {
              setAdding(false);
              setCurrency(account.currency);
            }}
            onUpgrade={() => {
              setAdding(false);
              router.push('/kyc');
            }}
          />
        )}
      </Screen>
    );
  }

  const details = wallet.receiving_details;
  const info = CURRENCIES[wallet.currency];
  const share = async () => {
    try {
      await Share.share({ message: shareMessage(details, info.name) });
    } catch {
      toast.show({
        message: "Sharing isn't available here. Copy the details instead.",
        tone: 'error',
      });
    }
  };

  return (
    <Screen header={header} edges={['top', 'bottom']}>
      {foreign.length > 1 && (
        <View style={[styles.chips, { gap: spacing[2] }]} accessibilityRole="tablist">
          {foreign.map((a) => (
            <Chip
              key={a.id}
              label={`${CURRENCIES[a.currency].flag} ${a.currency}`}
              selected={a.id === wallet.id}
              onPress={() => setCurrency(a.currency)}
            />
          ))}
        </View>
      )}

      <View style={[styles.row, { gap: spacing[2] }]}>
        <Text color="textMuted" style={styles.flex}>
          Your {info.name} details. People pay them from their own bank, like any local account.
        </Text>
        {details.demo && <Badge label="Demo details" tone="warning" />}
      </View>
      <ReceivingDetailsCard details={details} />
      <Button label="Share details" icon={Share2} onPress={() => void share()} />

      {isForeignScheme(details.scheme) && (
        <>
          <SectionHeader title="How it works" />
          <ReceiveGuideCard currency={wallet.currency} guide={RECEIVE_GUIDES[details.scheme]} />
        </>
      )}

      <SectionHeader title="Money in" />
      <RecentInbound account={wallet} />
      {env.apiMode === 'mock' && <SimulateInbound account={wallet} />}

      {params.entry === 'wallet' && (
        <Button
          label={`Convert ${wallet.currency} to naira`}
          icon={ArrowLeftRight}
          variant="ghost"
          onPress={() =>
            router.replace({ pathname: '/convert', params: { from: wallet.currency } })
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
});
