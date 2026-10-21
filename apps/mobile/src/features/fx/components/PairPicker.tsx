import type { Schema } from '@nem/contracts';
import { CURRENCIES, formatMoney } from '@nem/shared';
import { ArrowDownUp } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button, IconButton, SelectSheet } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

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
  label: `${CURRENCIES[a.currency].flag} ${a.nickname ?? `${a.currency} wallet`}`,
  description: `${formatMoney(fromApiMoney(a.available_balance))} available`,
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
  return (
    <View style={{ gap: spacing[1] }}>
      <SelectSheet
        label="From"
        title="Convert from"
        options={wallets.map(walletOption)}
        value={from.id}
        onChange={onFrom}
      />
      <View style={styles.center}>
        <IconButton
          icon={ArrowDownUp}
          accessibilityLabel={`Swap: convert ${to.currency} to ${from.currency} instead`}
          variant="ghost"
          onPress={onSwap}
        />
      </View>
      <SelectSheet
        label="To"
        title="Convert to"
        options={partners.map(walletOption)}
        value={to.id}
        onChange={onTo}
        help={from.currency === 'NGN' ? undefined : 'Foreign wallets convert back to naira.'}
      />
      {onAddWallet && (
        <Button label="Add another wallet" variant="ghost" size="sm" onPress={onAddWallet} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
});
