import type { Schema } from '@nem/contracts';
import { CURRENCIES, formatMoney } from '@nem/shared';
import { ArrowDownUp } from '@/components/icons';
import { StyleSheet, View } from 'react-native';

import { Button, IconButton, SelectSheet } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';

type Account = Schema<'Account'>;

export type Props = {
  wallets: readonly Account[];
  from: Account;
  to: Account;
  /** The wallets `from` can convert into. */
  partners: readonly Account[];
  onFrom: (id: string) => void;
  onTo: (id: string) => void;
  onSwap: () => void;
  /** Offered while naira can still convert into a wallet the customer does not have. */
  onAddWallet?: () => void;
};

const walletOption = (a: Account) => ({
  value: a.id,
  label: `${CURRENCIES[a.currency].flag} ${a.nickname ?? i18n.t('fx.pair.walletName', { currency: a.currency })}`,
  description: i18n.t('fx.pair.availableAmount', {
    amount: formatMoney(fromApiMoney(a.available_balance)),
  }),
});

/** Which wallet to convert from and into, with a swap between them. */
export function PairPicker({
  wallets,
  from,
  to,
  partners,
  onFrom,
  onTo,
  onSwap,
  onAddWallet,
}: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={{ gap: spacing[1] }}>
      <SelectSheet
        label={t('common.from')}
        title={t('fx.pair.from')}
        options={wallets.map(walletOption)}
        value={from.id}
        onChange={onFrom}
      />
      <View style={styles.center}>
        <IconButton
          icon={ArrowDownUp}
          accessibilityLabel={t('fx.pair.swap', { to: to.currency, from: from.currency })}
          variant="ghost"
          onPress={onSwap}
        />
      </View>
      <SelectSheet
        label={t('common.to')}
        title={t('fx.pair.to')}
        options={partners.map(walletOption)}
        value={to.id}
        onChange={onTo}
        help={from.currency === 'NGN' ? undefined : t('fx.pair.backToNaira')}
      />
      {onAddWallet && (
        <Button label={t('fx.pair.addAnother')} variant="ghost" size="sm" onPress={onAddWallet} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
});
