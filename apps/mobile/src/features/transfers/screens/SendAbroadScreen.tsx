import { add, CURRENCIES, formatMoney, money, parseRate } from '@nem/shared';
import { Globe, Info } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  Icon,
  PaidFeatureNotice,
  Screen,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import { toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import {
  abroadFee,
  accountLabel,
  deliveryEstimate,
  DESTINATIONS,
  PURPOSES,
  receiveEstimate,
  recipientProblems,
  type Destination,
} from '../abroad';
import { typedNaira } from '../amount';
import { SendHeader } from '../components/SendHeader';
import { useTranslation } from 'react-i18next';

type Purpose = (typeof PURPOSES)[number]['value'];

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.between}>
      <Text color="textMuted">{label}</Text>
      <Text variant={strong ? 'bodyStrong' : 'body'}>{value}</Text>
    </View>
  );
}

/**
 * Send abroad (TRF-14), designed in full: where to, how much with the rate and
 * fee up front, who receives it and why. Sending needs a licensed remittance
 * partner, so the last step asks the bank, which answers with the Paid Feature
 * Notice instead of pretending the money left.
 */
export function SendAbroadScreen() {
  const { spacing } = useTheme();
  const [destination, setDestination] = useState<Destination>(DESTINATIONS[0]);
  const [typed, setTyped] = useState('');
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [bic, setBic] = useState('');
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [error, setError] = useState<string>();
  const { t } = useTranslation();

  const rates = useRepoQuery('fx', 'listRates', undefined, { staleTime: 60_000 });
  const accounts = useRepoQuery('accounts', 'list');
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');
  const send = useMoneyMutation('transfers', 'createInternational', { invalidates: [] });

  const currency = CURRENCIES[destination.currency];
  const rate = rates.data?.data.find((r) => r.pair === `${destination.currency}-NGN`);
  const amount = typedNaira(typed);
  const fee = amount ? abroadFee(amount) : null;
  const gets = amount && rate ? receiveEstimate(amount, rate.buy_rate, destination.currency) : null;
  const perUnit = rate
    ? (() => {
        const { numerator, denominator } = parseRate(rate.buy_rate);
        return money((numerator * 100n) / denominator, 'NGN');
      })()
    : null;

  const problems = recipientProblems({ name, account, bic }, destination);
  const complete =
    Boolean(amount && source && purpose && name.trim() && account.trim()) &&
    (!destination.needsBic || Boolean(bic.trim())) &&
    !problems.name &&
    !problems.account &&
    !problems.bic;

  const submit = () => {
    if (!complete || !amount || !source || !purpose) return;
    setError(undefined);
    send.mutate(
      {
        body: {
          source_account_id: source.id,
          amount: toApiMoney(amount),
          recipient_name: name.trim(),
          recipient_country: destination.country,
          recipient_iban_or_account: account.replace(/\s+/g, '').toUpperCase(),
          ...(bic.trim() ? { recipient_bic: bic.replace(/\s+/g, '').toUpperCase() } : {}),
          purpose,
        },
      },
      {
        onError: (e) => {
          send.resetIntent();
          if (isApiError(e) && e.code === 'paid_feature_required') setNoticeOpen(true);
          else {
            setError(
              isApiError(e)
                ? (e.problem.detail ?? e.problem.title)
                : t('transfers.abroadScreen.tryAgain'),
            );
          }
        },
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('transfers.abroadScreen.title')} />}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {error && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          <Button
            label={
              amount
                ? t('transfers.abroadScreen.sendAmount', { amount: formatMoney(amount) })
                : t('common.continue')
            }
            icon={Globe}
            disabled={!complete}
            loading={send.isPending}
            onPress={submit}
          />
        </View>
      }
    >
      <Card>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Icon icon={Info} color="warning" />
          <Text variant="bodySmall" style={styles.flex}>
            {t('transfers.abroadScreen.partnerNote')}
          </Text>
          <Badge label={t('transfers.abroadScreen.partnerNeeded')} tone="warning" />
        </View>
      </Card>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          {t('transfers.abroadScreen.sendingTo')}
        </Text>
        <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
          {DESTINATIONS.map((d) => (
            <Chip
              key={d.country}
              label={`${d.flag} ${d.name}`}
              selected={destination.country === d.country}
              onPress={() => {
                setDestination(d);
                setAccount('');
                setBic('');
              }}
            />
          ))}
        </View>
      </View>

      <AmountInput
        currency="NGN"
        label={t('transfers.abroadScreen.youSend')}
        value={typed}
        onChangeValue={setTyped}
      />

      <Card>
        <View style={{ gap: spacing[2] }}>
          <Row
            label={t('transfers.abroadScreen.rate')}
            value={
              perUnit
                ? t('transfers.abroadScreen.rateValue', {
                    symbol: currency.symbol,
                    amount: formatMoney(perUnit),
                  })
                : t('common.loadingDots')
            }
          />
          <Row
            label={t('transfers.abroadScreen.fee')}
            value={fee ? formatMoney(fee) : t('transfers.abroadScreen.feeHint')}
          />
          {amount && fee && (
            <Row label={t('transfers.abroadScreen.total')} value={formatMoney(add(amount, fee))} />
          )}
          <Divider />
          <Row
            label={t('transfers.abroadScreen.theyGet')}
            value={gets ? formatMoney(gets) : `${currency.symbol}0.00`}
            strong
          />
          <Row label={t('transfers.abroadScreen.arrives')} value={deliveryEstimate()} />
          {rates.data?.indicative && (
            <Text variant="bodySmall" color="textMuted">
              {t('transfers.abroadScreen.indicative')}
            </Text>
          )}
        </View>
      </Card>

      <View style={{ gap: spacing[3] }}>
        <Text variant="label" color="textMuted">
          {t('transfers.abroadScreen.receiving')}
        </Text>
        <TextField
          label={t('transfers.abroadScreen.fullName')}
          placeholder="Chiamaka Okafor"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          error={problems.name}
        />
        <TextField
          label={accountLabel(destination)}
          placeholder={destination.country === 'US' ? '000123456789' : `${destination.country}…`}
          value={account}
          onChangeText={setAccount}
          autoCapitalize="characters"
          autoCorrect={false}
          error={problems.account}
        />
        <TextField
          label={t('transfers.abroadScreen.bic')}
          optional={!destination.needsBic}
          placeholder="CHASUS33"
          value={bic}
          onChangeText={setBic}
          autoCapitalize="characters"
          autoCorrect={false}
          error={problems.bic}
          help={destination.needsBic ? t('transfers.abroadScreen.bicHelp') : undefined}
        />
      </View>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          {t('transfers.abroadScreen.whatFor')}
        </Text>
        <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
          {PURPOSES.map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              selected={purpose === p.value}
              onPress={() => setPurpose(p.value)}
            />
          ))}
        </View>
        <Text variant="bodySmall" color="textMuted">
          {t('transfers.abroadScreen.reasonRule')}
        </Text>
      </View>

      <PaidFeatureNotice
        open={noticeOpen}
        onClose={() => setNoticeOpen(false)}
        feature="internationalTransfer"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
});
