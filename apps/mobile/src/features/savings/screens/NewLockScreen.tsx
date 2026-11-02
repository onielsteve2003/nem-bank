import { add, compare, formatMoney, parseMajor } from '@nem/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
  const min = `₦${MIN_LOCK_NAIRA.toLocaleString('en-NG')}`;

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
      header={<SendHeader title={t('savings.newLock.title')} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={
            amount && valid
              ? t('savings.newLock.lockAmount', {
                  amount: formatMoney(amount, { trimZeroMinor: true }),
                })
              : t('savings.newLock.lock')
          }
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
          available ? t('savings.newLock.help', { amount: formatMoney(available), min }) : undefined
        }
        error={
          tooSmall
            ? t('savings.newLock.tooSmall', { min })
            : tooMuch
              ? t('common.moreThanNaira')
              : undefined
        }
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">{t('savings.newLock.termLabel')}</Text>
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
                <DetailRow
                  label={t('savings.locks.rate')}
                  value={t('savings.locks.rateFixed', { rate: ratePct(q.rate_bps) })}
                />
                <DetailRow
                  label={t('savings.locks.interestAtMaturity')}
                  value={formatMoney(fromApiMoney(q.interest_at_maturity))}
                />
                <DetailRow
                  label={t('savings.newLock.maturesOn')}
                  value={formatGoalDate(q.maturity_date)}
                />
                <DetailRow
                  label={t('savings.newLock.youGetBack')}
                  value={formatMoney(
                    add(fromApiMoney(q.amount), fromApiMoney(q.interest_at_maturity)),
                  )}
                />
              </View>
            </Card>
            <Card>
              <View style={{ gap: spacing[2] }}>
                <Text variant="bodyStrong">{t('savings.newLock.ifBreak')}</Text>
                <Text variant="bodySmall" color="textMuted">
                  {t('savings.newLock.penalty', {
                    explanation: q.early_break_explanation,
                    rate: ratePct(q.early_break_penalty_bps),
                  })}
                </Text>
              </View>
            </Card>
            <Checkbox
              label={t('savings.newLock.accept')}
              checked={accepted}
              onChange={setAccepted}
            />
          </>
        ) : quote.isError ? (
          <Text variant="bodySmall" color="danger" accessibilityRole="alert">
            {t('savings.newLock.quoteFailed')}
          </Text>
        ) : (
          <SkeletonGroup accessibilityLabel={t('savings.newLock.quoteLoading')}>
            <Skeleton height={160} />
          </SkeletonGroup>
        ))}

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={
          amount
            ? t('savings.newLock.confirm', { amount: formatMoney(amount), term: termLabel(term) })
            : ''
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
