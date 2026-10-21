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
  DELIVERY_ESTIMATE,
  DESTINATIONS,
  PURPOSES,
  receiveEstimate,
  recipientProblems,
  type Destination,
} from '../abroad';
import { typedNaira } from '../amount';
import { SendHeader } from '../components/SendHeader';

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
          else setError(isApiError(e) ? (e.problem.detail ?? e.problem.title) : 'Try again.');
        },
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title="Send abroad" />}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {error && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          <Button
            label={amount ? `Send ${formatMoney(amount)}` : 'Continue'}
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
            Sending abroad needs a licensed remittance partner. Everything here works as it will
            then; the last step shows what&apos;s needed.
          </Text>
          <Badge label="Partner needed" tone="warning" />
        </View>
      </Card>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          Sending to
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

      <AmountInput currency="NGN" label="You send" value={typed} onChangeValue={setTyped} />

      <Card>
        <View style={{ gap: spacing[2] }}>
          <Row
            label="Rate"
            value={perUnit ? `${currency.symbol}1 = ${formatMoney(perUnit)}` : 'Loading…'}
          />
          <Row label="Partner fee (estimate)" value={fee ? formatMoney(fee) : '1%, min ₦2,000'} />
          {amount && fee && (
            <Row label="Total from your account" value={formatMoney(add(amount, fee))} />
          )}
          <Divider />
          <Row
            label="They get about"
            value={gets ? formatMoney(gets) : `${currency.symbol}0.00`}
            strong
          />
          <Row label="Arrives in" value={DELIVERY_ESTIMATE} />
          {rates.data?.indicative && (
            <Text variant="bodySmall" color="textMuted">
              Indicative rate. The partner fixes the exact rate when you send.
            </Text>
          )}
        </View>
      </Card>

      <View style={{ gap: spacing[3] }}>
        <Text variant="label" color="textMuted">
          Who&apos;s receiving it
        </Text>
        <TextField
          label="Full name"
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
          label="SWIFT / BIC"
          optional={!destination.needsBic}
          placeholder="CHASUS33"
          value={bic}
          onChangeText={setBic}
          autoCapitalize="characters"
          autoCorrect={false}
          error={problems.bic}
          help={destination.needsBic ? 'US banks need one for international transfers.' : undefined}
        />
      </View>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          What&apos;s it for?
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
          Nigerian rules ask for a reason on every transfer abroad.
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
