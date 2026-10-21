import type { Schema } from '@nem/contracts';
import { formatMoney, type CurrencyCode } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowDownLeft, ChartLine, History, Lock, Wallet } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  Button,
  EmptyState,
  ErrorState,
  MoneyText,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { AddWalletSheet } from '@/features/accounts/AddWalletSheet';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ConvertDone } from '../components/ConvertDone';
import { useFxQuote } from '../hooks/useFxQuote';
import { FxQuoteCard } from '../components/FxQuoteCard';
import { PairPicker } from '../components/PairPicker';
import { convertErrorMessage, convertibleInto, convertProblem } from '../quote';

type Conversion = Schema<'FxConversion'>;

/**
 * Convert between naira and a foreign wallet (FX-1). The typed amount is priced
 * live; the quote shows the rate against mid-market, what the spread costs and
 * the fee, and is held for 60 seconds. Converting takes the PIN or Face ID and
 * goes out with one idempotency key, so a retry never converts twice.
 */
export function ConvertScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const params = useLocalSearchParams<{ from?: string }>();
  const accounts = useRepoQuery('accounts', 'list');
  const me = useRepoQuery('users', 'getMe');
  const [fromId, setFromId] = useState<string>();
  const [toId, setToId] = useState<string>();
  const [typed, setTyped] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [done, setDone] = useState<Conversion | null>(null);

  const wallets = useMemo(() => accounts.data?.data ?? [], [accounts.data]);
  const from =
    wallets.find((a) => a.id === fromId) ??
    wallets.find((a) => a.currency === (params.from as CurrencyCode)) ??
    wallets.find((a) => a.currency === 'NGN');
  const partners = from ? convertibleInto(wallets, from) : [];
  const to = partners.find((a) => a.id === toId) ?? partners[0];

  const { sell, quote, current, secondsLeft, live } = useFxQuote(from, to, typed);
  const convert = useMoneyMutation('fx', 'convert');

  const available = from ? fromApiMoney(from.available_balance) : null;
  const problem = sell && available ? convertProblem(sell, available) : null;

  const changeFrom = (id: string) => {
    setFromId(id);
    setToId(undefined);
    setTyped('');
    setError(undefined);
  };

  const swap = () => {
    if (!from || !to) return;
    haptic('selection');
    setFromId(to.id);
    setToId(from.id);
    setTyped('');
    setError(undefined);
  };

  const requote = () => {
    setError(undefined);
    void quote.refetch();
  };

  const onApproved = useCallback(async () => {
    if (!current) return false;
    setError(undefined);
    try {
      const conversion = await convert.mutateAsync({ body: { quote_id: current.quote_id } });
      setConfirming(false);
      haptic('success');
      setDone(conversion);
      return true;
    } catch (e) {
      const { message, requote: stale } = convertErrorMessage(e as Error);
      setError(message);
      if (stale) {
        setConfirming(false);
        void quote.refetch();
      }
      return false;
    }
  }, [current, convert, quote]);

  const header = <SendHeader title="Convert" first />;

  if (done) {
    return (
      <ConvertDone
        conversion={done}
        onDone={() => router.back()}
        onAgain={() => {
          setDone(null);
          setTyped('');
          convert.resetIntent();
        }}
      />
    );
  }

  if (accounts.isError) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <ErrorState title="We couldn't load your wallets" onRetry={() => accounts.refetch()} />
      </Screen>
    );
  }

  if (!accounts.data || !from) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel="Loading your wallets">
          <Skeleton height={56} />
          <Skeleton height={56} />
          <Skeleton height={72} />
        </SkeletonGroup>
      </Screen>
    );
  }

  const addWallet = adding && (
    <AddWalletSheet
      open
      accounts={wallets}
      tier={me.data?.kyc_tier}
      onClose={() => setAdding(false)}
      onOpened={(account) => {
        setAdding(false);
        setToId(account.id);
      }}
      onUpgrade={() => {
        setAdding(false);
        router.push('/kyc');
      }}
    />
  );

  if (!to) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Wallet}
          title="Add a foreign wallet first"
          message="Open a USD, GBP or EUR wallet, then convert naira into it and back."
          actionLabel="Add a wallet"
          onAction={() => setAdding(true)}
        />
        {addWallet}
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {error && !confirming && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          <Button
            label={sell ? `Convert ${formatMoney(sell)}` : 'Convert'}
            icon={Lock}
            disabled={!live || problem !== null}
            onPress={() => {
              setError(undefined);
              setConfirming(true);
            }}
          />
        </View>
      }
    >
      <PairPicker
        wallets={wallets}
        from={from}
        to={to}
        partners={partners}
        onFrom={changeFrom}
        onTo={(id) => {
          setToId(id);
          setError(undefined);
        }}
        onSwap={swap}
        onAddWallet={
          from.currency === 'NGN' && partners.length < 3 ? () => setAdding(true) : undefined
        }
      />

      <AmountInput
        currency={from.currency}
        value={typed}
        onChangeValue={(v) => {
          setTyped(v);
          setError(undefined);
        }}
        error={problem ?? undefined}
      />

      {available && (
        <View style={[styles.row, styles.center, { gap: spacing[1] }]}>
          <Text variant="bodySmall" color="textMuted">
            Available
          </Text>
          <MoneyText value={available} variant="bodySmall" color="textMuted" label="Available" />
        </View>
      )}

      {quote.data && sell ? (
        <FxQuoteCard
          quote={quote.data}
          secondsLeft={secondsLeft}
          updating={!current}
          onRequote={requote}
          requoting={quote.isFetching}
        />
      ) : quote.isError && sell ? (
        <ErrorState
          title="We couldn't get a rate"
          message={quote.error.problem.detail ?? quote.error.problem.title}
          onRetry={requote}
        />
      ) : (
        <Text variant="bodySmall" color="textMuted" style={styles.hint}>
          Rates are indicative and held for 60 seconds once quoted.
        </Text>
      )}

      <Button
        label="Rate charts and alerts"
        icon={ChartLine}
        variant="ghost"
        onPress={() =>
          router.push({
            pathname: '/convert/rates',
            params: { pair: `${(from.currency === 'NGN' ? to : from).currency}-NGN` },
          })
        }
      />

      <Button
        label="Conversion history"
        icon={History}
        variant="ghost"
        onPress={() => router.push('/convert/history')}
      />
      <Button
        label="Receive from abroad"
        icon={ArrowDownLeft}
        variant="ghost"
        onPress={() =>
          router.push({
            pathname: '/convert/receive',
            params: { currency: (from.currency === 'NGN' ? to : from).currency },
          })
        }
      />

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={
          current
            ? `Convert ${formatMoney(fromApiMoney(current.sell))} to ${formatMoney(fromApiMoney(current.buy))}`
            : 'Convert'
        }
        onApproved={onApproved}
        error={error}
      />
      {addWallet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  hint: { textAlign: 'center' },
});
