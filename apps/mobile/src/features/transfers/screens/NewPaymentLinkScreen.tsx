import { useRouter } from 'expo-router';
import { Link2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountInput, Button, Chip, Screen, Text, TextField } from '@/components';
import { toApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { typedNaira } from '../amount';
import { SendHeader } from '../components/SendHeader';
import {
  LINK_EXPIRY_CHOICES,
  LINK_NOTE_MAX_LENGTH,
  LINK_TITLE_MAX_LENGTH,
  linkErrorMessage,
  linkExpiresAt,
  type LinkExpiryDays,
} from '../paymentLinks';

type Mode = 'fixed' | 'open';

/**
 * Make a payment link (TRF-12): what it is for, a set amount or "they choose",
 * and how long it takes payments. Money arrives in the naira account.
 */
export function NewPaymentLinkScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<Mode>('fixed');
  const [typed, setTyped] = useState('');
  const [days, setDays] = useState<LinkExpiryDays>(null);
  const [error, setError] = useState<string>();

  const accounts = useRepoQuery('accounts', 'list');
  const ngn = accounts.data?.data.find((a) => a.currency === 'NGN');
  const create = useRepoMutation('paymentLinks', 'create', { invalidates: [['paymentLinks']] });

  const amount = mode === 'fixed' ? typedNaira(typed) : null;
  const ready = Boolean(ngn && title.trim() && (mode === 'open' || amount));

  const submit = () => {
    if (!ngn || !ready) return;
    setError(undefined);
    const expiresAt = linkExpiresAt(days);
    create.mutate(
      {
        body: {
          account_id: ngn.id,
          title: title.trim(),
          amount_mode: mode,
          ...(amount ? { amount: toApiMoney(amount) } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(expiresAt ? { expires_at: expiresAt } : {}),
        },
      },
      {
        onSuccess: (link) =>
          router.replace({ pathname: '/send/links', params: { created: link.id } }),
        onError: (e) => setError(linkErrorMessage(e)),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title="New payment link" />}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {error && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          <Button
            label="Create link"
            icon={Link2}
            disabled={!ready}
            loading={create.isPending}
            onPress={submit}
          />
        </View>
      }
    >
      <TextField
        label="What's it for?"
        placeholder="Ankara fabric, 6 yards"
        value={title}
        onChangeText={setTitle}
        maxLength={LINK_TITLE_MAX_LENGTH}
        autoFocus
        help="Payers see this on the pay page."
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          Amount
        </Text>
        <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
          <Chip label="Set amount" selected={mode === 'fixed'} onPress={() => setMode('fixed')} />
          <Chip label="They choose" selected={mode === 'open'} onPress={() => setMode('open')} />
        </View>
      </View>
      {mode === 'fixed' ? (
        <AmountInput currency="NGN" value={typed} onChangeValue={setTyped} />
      ) : (
        <Text color="textMuted">
          Good for contributions and tips: each payer types what they want to give.
        </Text>
      )}

      <TextField
        label="Note"
        optional
        placeholder="Delivery in Lekki on Saturday"
        value={note}
        onChangeText={setNote}
        maxLength={LINK_NOTE_MAX_LENGTH}
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          Takes payments for
        </Text>
        <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
          {LINK_EXPIRY_CHOICES.map((c) => (
            <Chip
              key={c.label}
              label={c.label}
              selected={days === c.days}
              onPress={() => setDays(c.days)}
            />
          ))}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
