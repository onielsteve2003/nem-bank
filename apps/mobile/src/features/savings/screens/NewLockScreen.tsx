import { add, compare, formatMoney, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  Button,
  Card,
  Checkbox,
  Chip,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { typedNaira } from '@/features/transfers/amount';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { DetailRow } from '../components/DetailRow';
import { formatGoalDate } from '../goals';
import { LOCK_TERMS, MIN_LOCK_NAIRA, ratePct, termLabel } from '../locks';

const MIN_LOCK = parseMajor(String(MIN_LOCK_NAIRA), 'NGN');

/**
 * Lock money away (SAV-4): an amount from naira and a term. The bank's quote
 * shows the fixed rate, the interest at maturity, the maturity date and what
 * breaking early costs, and the customer must accept that before the PIN.
 */
export function NewLockScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState<number>(90);
  const [accepted, setAccepted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const accounts = useRepoQuery('accounts', 'list');
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const create = useMoneyMutation('savings', 'createLock', {
    invalidates: [['savings'], ['accounts'], ['transactions']],
  });

  const amount = typedNaira(typed);
  const available = naira ? fromApiMoney(naira.available_balance) : null;
  const tooSmall = amount !== null && compare(amount, MIN_LOCK) < 0;
  const tooMuch = amount !== null && available !== null && compare(amount, available) > 0;
  const valid = amount !== null && !tooSmall && !tooMuch;
  const quote = useRepoQuery(
    'savings',
    'quoteLock',
    { body: { amount: toApiMoney(amount ?? MIN_LOCK), term_days: term } },
    { enabled: valid },
  );
  const q = valid ? quote.data : undefined;

  const run = async () => {
    if (!amount || !naira) return false;
    setError(undefined);
    try {
      const lock = await create.mutateAsync({
        body: {
          amount: toApiMoney(amount),
          term_days: term,
          source_account_id: naira.id,
          accepted_terms: true,
        },
      });
      setConfirming(false);
      router.replace({ pathname: '/locks/[id]', params: { id: lock.id } });
      return true;
    } catch (e) {
      setError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  return (
    <Screen
      header={<SendHeader title="Lock money" />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={amount && valid ? `Lock ${formatMoney(amount, { trimZeroMinor: true })}` : 'Lock'}
          disabled={!q || !accepted || !naira}
          onPress={() => {
            create.resetIntent();
            setConfirming(true);
          }}
        />
      }
    >
      <AmountInput
        currency="NGN"
        value={typed}
        onChangeValue={(v) => {
          setTyped(v);
          setAccepted(false);
        }}
        maxWholeDigits={9}
        help={
          available
            ? `${formatMoney(available)} available · lock at least ₦${MIN_LOCK_NAIRA.toLocaleString('en-NG')}`
            : undefined
        }
        error={
          tooSmall
            ? `Lock at least ₦${MIN_LOCK_NAIRA.toLocaleString('en-NG')}`
            : tooMuch
              ? 'More than you have in your naira account'
              : undefined
        }
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Lock it for</Text>
        <View accessibilityRole="radiogroup" style={[styles.chips, { gap: spacing[2] }]}>
          {LOCK_TERMS.map((days) => (
            <Chip
              key={days}
              label={termLabel(days)}
              selected={term === days}
              onPress={() => {
                setTerm(days);
                setAccepted(false);
              }}
            />
          ))}
        </View>
      </View>

      {valid &&
        (q ? (
          <>
            <Card>
              <View style={{ gap: spacing[3] }}>
                <DetailRow label="Rate" value={`${ratePct(q.rate_bps)} a year, fixed`} />
                <DetailRow
                  label="Interest at maturity"
                  value={formatMoney(fromApiMoney(q.interest_at_maturity))}
                />
                <DetailRow label="Matures on" value={formatGoalDate(q.maturity_date)} />
                <DetailRow
                  label="You get back"
                  value={formatMoney(
                    add(fromApiMoney(q.amount), fromApiMoney(q.interest_at_maturity)),
                  )}
                />
              </View>
            </Card>
            <Card>
              <View style={{ gap: spacing[2] }}>
                <Text variant="bodyStrong">If you break it early</Text>
                <Text variant="bodySmall" color="textMuted">
                  {q.early_break_explanation} The penalty is {ratePct(q.early_break_penalty_bps)} of
                  the interest earned so far.
                </Text>
              </View>
            </Card>
            <Checkbox
              label="I understand the early-break penalty"
              checked={accepted}
              onChange={setAccepted}
            />
          </>
        ) : quote.isError ? (
          <Text variant="bodySmall" color="danger" accessibilityRole="alert">
            We couldn&apos;t get a rate. Change the amount or try again.
          </Text>
        ) : (
          <SkeletonGroup accessibilityLabel="Getting your rate">
            <Skeleton height={160} />
          </SkeletonGroup>
        ))}

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={
          amount ? `Lock ${formatMoney(amount)} for ${termLabel(term)} from your naira account` : ''
        }
        onApproved={run}
        error={error}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
