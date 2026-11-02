import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, HandCoins } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AmountInput, Avatar, Button, Card, Chip, Screen, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import { toApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

import { typedNaira } from '../amount';
import { SendHeader } from '../components/SendHeader';
import { nemLookupQuery } from '../recipient';
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_CHOICES,
  REQUEST_NOTE_MAX_LENGTH,
  requestErrorMessage,
} from '../requests';
import { LOOKUP_DELAY_MS } from './RecipientScreen';
import { useTranslation } from 'react-i18next';

/**
 * Ask a Nem user for money (TRF-10): find them by @nemtag, phone or account
 * number, say how much and what for. They get it in their requests inbox and
 * can pay or decline; nothing moves until they pay.
 */
export function RequestMoneyScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const [who, setWho] = useState('');
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState<number>(DEFAULT_EXPIRY_DAYS);
  const [error, setError] = useState<string>();
  const { t } = useTranslation();

  const query = nemLookupQuery(useDebounced(who, LOOKUP_DELAY_MS));
  const lookup = useRepoQuery(
    'payees',
    'resolve',
    { body: { kind: 'nem', query: query ?? '' } },
    { enabled: query !== null, retry: false, staleTime: 60_000 },
  );
  const payer = query ? lookup.data : undefined;
  const lookupError =
    query && isApiError(lookup.error)
      ? lookup.error.status < 500
        ? (lookup.error.problem.detail ?? t('transfers.recipient.noNemUser'))
        : t('transfers.requestMoney.lookupFailed')
      : undefined;

  const amount = typedNaira(typed);
  const create = useRepoMutation('moneyRequests', 'create');
  const firstName = payer?.name.split(' ')[0];

  const send = () => {
    if (!payer?.nemtag || !amount) return;
    setError(undefined);
    create.mutate(
      {
        body: {
          payer_nemtag: payer.nemtag,
          amount: toApiMoney(amount),
          ...(note.trim() ? { note: note.trim() } : {}),
          expires_in_days: days,
        },
      },
      {
        onSuccess: (request) =>
          router.replace({
            pathname: '/send/requests',
            params: { tab: 'sent', created: request.id },
          }),
        onError: (e) => setError(requestErrorMessage(e)),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('transfers.requestMoney.title')} />}
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
              payer && amount
                ? t('transfers.requestMoney.requestFrom', {
                    amount: formatMoney(amount),
                    name: firstName,
                  })
                : t('transfers.requestMoney.title')
            }
            icon={HandCoins}
            disabled={!payer?.nemtag || !amount}
            loading={create.isPending}
            onPress={send}
          />
        </View>
      }
    >
      <TextField
        label={t('transfers.requestMoney.from')}
        placeholder={t('transfers.requestMoney.fromPlaceholder')}
        leadingIcon={AtSign}
        value={who}
        onChangeText={setWho}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        error={lookupError}
        help={lookupError ? undefined : t('transfers.requestMoney.nemOnly')}
        trailing={
          query && lookup.isFetching ? (
            <ActivityIndicator
              color={colors.textMuted}
              accessibilityLabel={t('common.lookingUpLabel')}
            />
          ) : undefined
        }
      />
      {payer && (
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Avatar name={payer.name} size="md" ring />
            <View style={styles.flex}>
              <Text variant="bodyStrong">{payer.name}</Text>
              <Text variant="bodySmall" color="textMuted">
                {payer.nemtag
                  ? t('transfers.requestMoney.nemUser', { nemtag: payer.nemtag })
                  : t('common.nemUser')}
              </Text>
            </View>
          </View>
        </Card>
      )}

      <AmountInput currency="NGN" value={typed} onChangeValue={setTyped} />

      <TextField
        label={t('transfers.requestMoney.whatFor')}
        optional
        placeholder={t('transfers.requestMoney.whatForPlaceholder')}
        value={note}
        onChangeText={setNote}
        maxLength={REQUEST_NOTE_MAX_LENGTH}
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label" color="textMuted">
          {t('transfers.requestMoney.theyHave')}
        </Text>
        <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
          {EXPIRY_CHOICES.map((c) => (
            <Chip
              key={c.days}
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
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
});
