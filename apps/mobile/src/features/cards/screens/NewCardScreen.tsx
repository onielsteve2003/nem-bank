import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { Lock } from '@/components/icons';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  BankCard,
  Button,
  Chip,
  ErrorState,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
  useToast,
  type CardDesign,
} from '@/components';
import { isApiError } from '@/data';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { haptic } from '@/lib/haptics';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import {
  CARD_DESIGNS,
  CARD_TYPES,
  LOCKABLE_MERCHANTS,
  type CardCurrency,
  type CardType,
} from '../cards';
import { CardTypeOptions } from '../components/CardTypeOptions';

export const NICKNAME_MAX = 30;
const CURRENCIES: CardCurrency[] = ['NGN', 'USD'];

/** "09/30" four years on, as the processor issues it; the preview shows the same. */
const previewExpiry = (now = new Date()) =>
  `${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCFullYear() + 4).slice(-2)}`;

/**
 * Create a virtual card (CARD-1): the wallet it spends from, its type (with the
 * merchant for a locked one), a name and a look, previewed live. Issuing takes
 * the PIN or Face ID and goes out once, however often it is retried.
 */
export function NewCardScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const accounts = useRepoQuery('accounts', 'list');
  const me = useRepoQuery('users', 'getMe');
  const [currency, setCurrency] = useState<CardCurrency>('NGN');
  const [type, setType] = useState<CardType>('standard');
  const [merchant, setMerchant] = useState<Schema<'MerchantLock'> | null>(null);
  const [nickname, setNickname] = useState('');
  const [design, setDesign] = useState<CardDesign>('volt');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const create = useMoneyMutation('cards', 'create', { invalidates: [['cards']] });

  const header = <SendHeader title={t('cards.new.title')} first />;
  const wallet = accounts.data?.data.find((a) => a.currency === currency);
  const hasUsd = accounts.data?.data.some((a) => a.currency === 'USD') ?? false;
  const needsMerchant = type === 'merchant_locked' && !merchant;
  const holder = me.data ? `${me.data.first_name} ${me.data.last_name}` : t('cards.new.yourName');

  const onApproved = useCallback(async () => {
    if (!wallet) return false;
    setError(undefined);
    try {
      const card = await create.mutateAsync({
        body: {
          account_id: wallet.id,
          type,
          design,
          ...(nickname.trim() && { nickname: nickname.trim() }),
          ...(type === 'merchant_locked' && merchant && { merchant_lock: merchant }),
        },
      });
      setConfirming(false);
      haptic('success');
      toast.show({ message: t('cards.new.ready', { last4: card.last4 }), tone: 'success' });
      router.back();
      return true;
    } catch (e) {
      const message = isApiError(e) ? (e.problem.detail ?? e.problem.title) : t('cards.new.failed');
      setError(message);
      // A refusal (tier, card limit) will not change on retry: show it on the screen.
      if (isApiError(e) && e.problem.status < 500 && e.problem.code !== 'offline') {
        setConfirming(false);
      }
      return false;
    }
  }, [wallet, create, type, design, nickname, merchant, toast, router, t]);

  if (accounts.isError) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <ErrorState title={t('common.walletsFailed')} onRetry={() => accounts.refetch()} />
      </Screen>
    );
  }
  if (!accounts.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel={t('common.loading')}>
          <Skeleton height={200} radius={16} />
          <Skeleton height={56} />
        </SkeletonGroup>
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
            label={t('cards.new.create')}
            icon={Lock}
            disabled={!wallet || needsMerchant}
            onPress={() => {
              setError(undefined);
              setConfirming(true);
            }}
          />
        </View>
      }
    >
      <BankCard
        holder={holder}
        last4="••••"
        expiry={previewExpiry()}
        network={currency === 'USD' ? 'visa' : 'verve'}
        design={design}
        tilt={false}
      />

      <SectionHeader title={t('cards.new.spendsFrom')} />
      <View style={[styles.chips, { gap: spacing[2] }]}>
        {CURRENCIES.map((c) => (
          <Chip
            key={c}
            label={t('cards.new.wallet', { currency: c })}
            selected={c === currency}
            disabled={c === 'USD' && !hasUsd}
            onPress={() => setCurrency(c)}
          />
        ))}
      </View>
      {!hasUsd && (
        <Text variant="caption" color="textMuted">
          {t('cards.new.needUsd')}
        </Text>
      )}

      <SectionHeader title={t('cards.new.type')} />
      <CardTypeOptions value={type} onChange={setType} />
      {type === 'merchant_locked' && (
        <View style={{ gap: spacing[2] }}>
          <Text variant="label">{t('cards.new.lockedTo')}</Text>
          <View style={[styles.chips, { gap: spacing[2] }]}>
            {LOCKABLE_MERCHANTS.map((m) => (
              <Chip
                key={m.merchant_id}
                label={m.merchant_name}
                selected={merchant?.merchant_id === m.merchant_id}
                onPress={() => setMerchant(m)}
              />
            ))}
          </View>
          {needsMerchant && (
            <Text variant="caption" color="textMuted">
              {t('cards.new.pickMerchant')}
            </Text>
          )}
        </View>
      )}

      <TextField
        label={t('cards.new.name')}
        optional
        placeholder={t('cards.typeCard', { type: CARD_TYPES[type].label })}
        value={nickname}
        onChangeText={setNickname}
        maxLength={NICKNAME_MAX}
        help={t('cards.new.nameHelp', { max: NICKNAME_MAX })}
      />

      <SectionHeader title={t('cards.new.look')} />
      <View style={[styles.chips, { gap: spacing[2] }]}>
        {CARD_DESIGNS.map((d) => (
          <Chip
            key={d.value}
            label={d.label}
            selected={d.value === design}
            onPress={() => setDesign(d.value)}
          />
        ))}
      </View>

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={t('cards.new.confirm', {
          type: CARD_TYPES[type].label.toLowerCase(),
          currency,
        })}
        onApproved={onApproved}
        error={error}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
