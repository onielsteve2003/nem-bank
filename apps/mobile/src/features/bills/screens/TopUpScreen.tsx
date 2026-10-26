import { formatMoney, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Phone } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  Button,
  Chip,
  ErrorState,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import {
  AIRTIME_PRESETS,
  isMobileNumber,
  localPhone,
  NETWORKS,
  toE164,
  topUpBillerId,
  type MobileNetwork,
} from '../bills';

/**
 * Airtime and data (BILL-1): the network is read from the number's prefix and
 * can be changed for ported numbers; data shows that network's bundles.
 */
export function TopUpScreen({ category }: { category: 'airtime' | 'data' }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const me = useRepoQuery('users', 'getMe');
  const accounts = useRepoQuery('accounts', 'list');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');

  const [typed, setTyped] = useState<string | null>(null);
  const [picked, setPicked] = useState<MobileNetwork | null>(null);
  const [amount, setAmount] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [payError, setPayError] = useState<string>();

  // Starts on the customer's own number, the one most people top up.
  const own = me.data?.phone ? localPhone(me.data.phone) : '';
  const phone = typed ?? own;

  const local = localPhone(phone);
  const complete = isMobileNumber(local);
  const detected = useRepoQuery(
    'bills',
    'detectNetwork',
    { body: { phone: toE164(local) } },
    { enabled: complete },
  );
  // A network the customer picked wins over the detected one (ported numbers).
  const network = picked ?? (complete ? (detected.data?.network ?? null) : null);

  const isData = category === 'data';
  const billerId = network ? topUpBillerId(network, category) : null;
  const products = useRepoQuery(
    'bills',
    'listProducts',
    { path: { biller_id: billerId ?? '' } },
    { enabled: isData && billerId !== null },
  );
  const product = products.data?.data.find((p) => p.id === productId);

  const price = isData
    ? product && fromApiMoney(product.amount)
    : amount
      ? parseMajor(amount, 'NGN')
      : undefined;
  const tooSmall = !isData && price !== undefined && price.amount < 5_000n;
  const ready = complete && billerId !== null && price !== undefined && !tooSmall && source;

  const pay = useMoneyMutation('bills', 'pay', {
    invalidates: [['bills'], ['accounts'], ['transactions']],
  });
  const networkName = NETWORKS.find((n) => n.value === network)?.label ?? '';

  const onApproved = async () => {
    if (!ready || !price) return false;
    setPayError(undefined);
    try {
      const payment = await pay.mutateAsync({
        body: {
          biller_id: billerId,
          product_id: product?.id,
          customer_id: local,
          amount: toApiMoney(price),
          source_account_id: source.id,
        },
      });
      setConfirming(false);
      router.replace({ pathname: '/bills/receipt/[id]', params: { id: payment.id } });
      return true;
    } catch (e) {
      setPayError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  const what = isData ? (product?.name ?? 'data') : 'airtime';

  return (
    <Screen
      header={<SendHeader title={isData ? 'Buy data' : 'Buy airtime'} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={price && ready ? `Buy ${formatMoney(price, { trimZeroMinor: true })}` : 'Buy'}
          disabled={!ready}
          onPress={() => {
            pay.resetIntent();
            setConfirming(true);
          }}
        />
      }
    >
      <TextField
        label="Phone number"
        leadingIcon={Phone}
        keyboardType="phone-pad"
        autoComplete="tel"
        value={phone}
        onChangeText={(text) => {
          setTyped(text);
          setPicked(null);
          setProductId(null);
        }}
        maxLength={14}
        error={local.length >= 11 && !complete ? 'Enter an 11-digit Nigerian number' : undefined}
        help={
          complete && detected.data && !detected.data.network
            ? "We couldn't tell the network. Pick it below."
            : undefined
        }
      />

      <View>
        <SectionHeader title="Network" />
        <View accessibilityRole="radiogroup" style={[styles.chips, { gap: spacing[2] }]}>
          {NETWORKS.map((n) => (
            <Chip
              key={n.value}
              label={n.label}
              selected={network === n.value}
              onPress={() => {
                setPicked(n.value);
                setProductId(null);
              }}
            />
          ))}
        </View>
        {complete && network && detected.data?.network === network && (
          <Text variant="caption" color="textMuted" style={{ marginTop: spacing[2] }}>
            Detected from the number. Ported it? Pick the right one.
          </Text>
        )}
      </View>

      {isData ? (
        <View>
          <SectionHeader title="Bundles" />
          {!billerId ? (
            <Text color="textMuted">Enter a number or pick a network to see bundles.</Text>
          ) : products.isError ? (
            <ErrorState title="We couldn't load bundles" onRetry={() => products.refetch()} />
          ) : !products.data ? (
            <SkeletonGroup accessibilityLabel="Loading bundles">
              <Skeleton height={56} />
              <Skeleton height={56} />
            </SkeletonGroup>
          ) : (
            <View>
              {products.data.data.map((p) => (
                <ListItem
                  key={p.id}
                  title={p.name}
                  subtitle={p.validity_days ? `Lasts ${p.validity_days} days` : undefined}
                  trailing={
                    <Text variant="bodyStrong" color={p.id === productId ? 'primaryText' : 'text'}>
                      {formatMoney(fromApiMoney(p.amount), { trimZeroMinor: true })}
                    </Text>
                  }
                  accessibilityLabel={`${p.name}, ${formatMoney(fromApiMoney(p.amount))}${p.id === productId ? ', selected' : ''}`}
                  onPress={() => setProductId(p.id)}
                />
              ))}
            </View>
          )}
        </View>
      ) : (
        <View style={{ gap: spacing[3] }}>
          <AmountInput
            currency="NGN"
            label="Amount"
            value={amount}
            onChangeValue={setAmount}
            maxWholeDigits={6}
            error={tooSmall ? 'The least you can buy is ₦50' : undefined}
          />
          <View style={[styles.chips, { gap: spacing[2] }]}>
            {AIRTIME_PRESETS.map((n) => (
              <Chip
                key={n}
                label={`₦${n.toLocaleString('en-NG')}`}
                selected={amount === String(n)}
                onPress={() => setAmount(String(n))}
              />
            ))}
          </View>
        </View>
      )}

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={price ? `Buy ${formatMoney(price)} ${networkName} ${what} for ${local}` : ''}
        onApproved={onApproved}
        error={payError}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
