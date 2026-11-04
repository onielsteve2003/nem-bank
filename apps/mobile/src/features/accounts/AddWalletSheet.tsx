import type { Schema } from '@nem/contracts';
import { CURRENCIES, MIN_TIER_FOR, type KycTier } from '@nem/shared';
import { ShieldCheck } from '@/components/icons';
import { View } from 'react-native';

import { BottomSheet, Button, EmptyState, ListItem, Text, useToast } from '@/components';
import { haptic } from '@/lib/haptics';
import { useMoneyMutation } from '@/lib/query';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

type Account = Schema<'Account'>;
export type ForeignCurrency = Schema<'OpenAccountRequest'>['currency'];

export const FOREIGN_CURRENCIES: readonly ForeignCurrency[] = ['USD', 'GBP', 'EUR'];

/** The foreign wallets this customer does not have yet, in display order. */
export function addableCurrencies(accounts: readonly Pick<Account, 'currency'>[]) {
  const held = new Set(accounts.map((a) => a.currency));
  return FOREIGN_CURRENCIES.filter((c) => !held.has(c));
}

/**
 * Open a USD, GBP or EUR wallet (ACC-2). Foreign wallets need Tier 2 (KYC-7):
 * below that the sheet explains why and links to verification instead of
 * offering a button the bank would refuse. Opening is idempotent, so a retry
 * after a dropped response never makes two wallets.
 */
export function AddWalletSheet({
  open,
  accounts,
  tier,
  onClose,
  onOpened,
  onUpgrade,
}: {
  open: boolean;
  accounts: readonly Account[];
  tier: KycTier | undefined;
  onClose: () => void;
  /** The new wallet, so the caller can show its receiving details. */
  onOpened: (account: Account) => void;
  onUpgrade: () => void;
}) {
  const { spacing } = useTheme();
  const toast = useToast();
  const { t } = useTranslation();
  const addable = addableCurrencies(accounts);
  const needed = MIN_TIER_FOR.fxWallets;
  const allowed = tier !== undefined && tier >= needed;

  const openWallet = useMoneyMutation('accounts', 'open', {
    invalidates: [['accounts']],
    onSuccess: (account) => {
      haptic('success');
      toast.show({
        message: t('accounts.addWallet.ready', { name: CURRENCIES[account.currency].name }),
        tone: 'success',
      });
      onOpened(account);
    },
  });
  const pending = openWallet.isPending ? openWallet.variables?.body.currency : undefined;

  const body = !allowed ? (
    <View style={{ gap: spacing[4] }}>
      <EmptyState
        icon={ShieldCheck}
        title={t('accounts.addWallet.verifyTitle', { tier: needed })}
        message={t('accounts.addWallet.verifyMessage', { tier: tier ?? 1 })}
      />
      <Button label={t('accounts.addWallet.verify')} onPress={onUpgrade} />
    </View>
  ) : addable.length === 0 ? (
    <EmptyState
      icon={ShieldCheck}
      title={t('accounts.addWallet.allTitle')}
      message={t('accounts.addWallet.allMessage')}
    />
  ) : (
    <View style={{ gap: spacing[3] }}>
      <Text color="textMuted">{t('accounts.addWallet.intro')}</Text>
      <View>
        {addable.map((code) => {
          const currency = CURRENCIES[code];
          return (
            <ListItem
              key={code}
              leading={<Text variant="title">{currency.flag}</Text>}
              title={t('common.walletName', { name: currency.name })}
              subtitle={
                pending === code
                  ? t('accounts.addWallet.opening')
                  : t('accounts.addWallet.receiveWith', {
                      method: t(`accounts.addWallet.receiveBy.${code}`),
                    })
              }
              accessibilityHint={t('accounts.addWallet.opensHint', { code })}
              disabled={openWallet.isPending}
              showChevron
              onPress={() => openWallet.mutate({ body: { currency: code } })}
            />
          );
        })}
      </View>
      {openWallet.isError && (
        <Text color="danger" accessibilityLiveRegion="polite" accessibilityRole="alert">
          {t('accounts.addWallet.tapRetry', {
            problem: openWallet.error.problem.detail ?? t('accounts.addWallet.failed'),
          })}
        </Text>
      )}
    </View>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title={t('accounts.addWallet.title')}>
      {body}
    </BottomSheet>
  );
}
