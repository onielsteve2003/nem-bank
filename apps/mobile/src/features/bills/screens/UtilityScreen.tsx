import { formatMoney, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { CircleCheck, Hash } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  Button,
  Card,
  Chip,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { categoryMeta, CUSTOMER_LABEL } from '../bills';

type Category = 'electricity' | 'cable_tv';

/** Meter numbers are 11 digits, smartcards 10. */
const ID_LENGTH: Record<Category, number> = { electricity: 11, cable_tv: 10 };

/**
 * Electricity and cable TV (BILL-2): pick the provider, check the meter or
 * smartcard against it, then buy units or a plan.
 */
export function UtilityScreen({ category }: { category: Category }) {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const meta = categoryMeta(category);
  const isPower = category === 'electricity';
  const accounts = useRepoQuery('accounts', 'list');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');

  const billers = useRepoQuery('bills', 'listBillers', { query: { category } });
  const [billerId, setBillerId] = useState<string | null>(null);
  const biller = billers.data?.data.find((b) => b.id === billerId);
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [productId, setProductId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [payError, setPayError] = useState<string>();

  const digits = customerId.replace(/\D/g, '');
  const complete = digits.length === ID_LENGTH[category];
  const validation = useRepoQuery(
    'bills',
    'validateCustomer',
    { body: { biller_id: billerId ?? '', customer_id: digits } },
    { enabled: billerId !== null && complete, retry: false },
  );
  const customer = validation.data;
  const notFound =
    validation.isError &&
    isApiError(validation.error) &&
    validation.error.problem.code === 'customer_not_found';

  const plans = useRepoQuery(
    'bills',
    'listProducts',
    { path: { biller_id: billerId ?? '' } },
    { enabled: !isPower && billerId !== null },
  );
  const plan = plans.data?.data.find((p) => p.id === productId);

  const min = biller?.min_amount ? fromApiMoney(biller.min_amount) : undefined;
  const price = isPower
    ? amount
      ? parseMajor(amount, 'NGN')
      : undefined
    : plan && fromApiMoney(plan.amount);
  const tooSmall = isPower && price !== undefined && min !== undefined && price.amount < min.amount;
  const ready = Boolean(customer && price && !tooSmall && source);

  const pay = useMoneyMutation('bills', 'pay', {
    invalidates: [['bills'], ['accounts'], ['transactions']],
  });

  const onApproved = async () => {
    if (!customer || !price || !source) return false;
    setPayError(undefined);
    try {
      const payment = await pay.mutateAsync({
        body: {
          biller_id: customer.biller_id,
          product_id: plan?.id,
          customer_id: customer.customer_id,
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

  return (
    <Screen
      header={<SendHeader title={meta.label} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={price && ready ? `Pay ${formatMoney(price, { trimZeroMinor: true })}` : 'Pay'}
          disabled={!ready}
          onPress={() => {
            pay.resetIntent();
            setConfirming(true);
          }}
        />
      }
    >
      <View>
        <SectionHeader title="Provider" />
        {billers.isError ? (
          <ErrorState title="We couldn't load the providers" onRetry={() => billers.refetch()} />
        ) : !billers.data ? (
          <SkeletonGroup accessibilityLabel="Loading providers">
            <Skeleton height={36} />
          </SkeletonGroup>
        ) : (
          <View style={[styles.chips, { gap: spacing[2] }]}>
            {billers.data.data.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                selected={b.id === billerId}
                onPress={() => {
                  setBillerId(b.id);
                  setProductId(null);
                }}
              />
            ))}
          </View>
        )}
      </View>

      <TextField
        label={CUSTOMER_LABEL[category]}
        leadingIcon={Hash}
        keyboardType="number-pad"
        value={customerId}
        onChangeText={setCustomerId}
        maxLength={ID_LENGTH[category]}
        help={
          !billerId
            ? 'Pick a provider first'
            : `${ID_LENGTH[category]} digits${isPower ? ', on the meter or your last token receipt' : ', under the decoder'}`
        }
        error={
          notFound
            ? `We couldn't find that ${isPower ? 'meter' : 'smartcard'} with ${biller?.name}`
            : validation.isError
              ? "We couldn't check that number. Try again."
              : undefined
        }
      />

      {complete && billerId && validation.isFetching && !customer && (
        <SkeletonGroup accessibilityLabel={`Checking the ${isPower ? 'meter' : 'smartcard'}`}>
          <Skeleton height={64} />
        </SkeletonGroup>
      )}
      {customer && (
        <View
          accessibilityRole="summary"
          style={[
            styles.customer,
            {
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing[4],
              gap: spacing[3],
            },
          ]}
        >
          <Icon icon={CircleCheck} color="success" />
          <View style={styles.flex}>
            <Text variant="bodyStrong">{customer.customer_name}</Text>
            {customer.address && (
              <Text variant="caption" color="textMuted">
                {customer.address}
              </Text>
            )}
            {customer.current_plan && (
              <Text variant="caption" color="textMuted">
                Current plan: {customer.current_plan}
              </Text>
            )}
          </View>
        </View>
      )}

      {customer &&
        (isPower ? (
          <AmountInput
            currency="NGN"
            label="Amount"
            value={amount}
            onChangeValue={setAmount}
            maxWholeDigits={7}
            help={min ? `At least ${formatMoney(min, { trimZeroMinor: true })}` : undefined}
            error={
              tooSmall && min
                ? `The least you can buy is ${formatMoney(min, { trimZeroMinor: true })}`
                : undefined
            }
          />
        ) : (
          <View>
            <SectionHeader title="Plans" />
            {plans.isError ? (
              <ErrorState title="We couldn't load the plans" onRetry={() => plans.refetch()} />
            ) : !plans.data ? (
              <SkeletonGroup accessibilityLabel="Loading plans">
                <Skeleton height={56} />
                <Skeleton height={56} />
              </SkeletonGroup>
            ) : (
              <Card padded={false}>
                {plans.data.data.map((p) => (
                  <ListItem
                    key={p.id}
                    title={p.name}
                    subtitle={
                      p.name === customer.current_plan
                        ? 'Current plan · Renew'
                        : p.validity_days
                          ? `${p.validity_days} days`
                          : undefined
                    }
                    trailing={
                      <Text
                        variant="bodyStrong"
                        color={p.id === productId ? 'primaryText' : 'text'}
                      >
                        {formatMoney(fromApiMoney(p.amount), { trimZeroMinor: true })}
                      </Text>
                    }
                    accessibilityLabel={`${p.name}, ${formatMoney(fromApiMoney(p.amount))}${p.id === productId ? ', selected' : ''}`}
                    onPress={() => setProductId(p.id)}
                  />
                ))}
              </Card>
            )}
          </View>
        ))}

      <Text variant="caption" color="textMuted">
        Billers are simulated: payments complete instantly and no real provider is charged.
      </Text>

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={
          price && customer
            ? `Pay ${formatMoney(price)} to ${biller?.name}${plan ? ` for ${plan.name}` : ''}, ${customer.customer_name}`
            : ''
        }
        onApproved={onApproved}
        error={payError}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  customer: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
});
