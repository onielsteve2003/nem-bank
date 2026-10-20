import type { Schema } from '@nem/contracts';
import { CURRENCIES, MIN_TIER_FOR, type KycTier } from '@nem/shared';
import { ShieldCheck } from 'lucide-react-native';
import { View } from 'react-native';

import { BottomSheet, Button, EmptyState, ListItem, Text, useToast } from '@/components';
import { haptic } from '@/lib/haptics';
import { useMoneyMutation } from '@/lib/query';
import { useTheme } from '@/theme';

type Account = Schema<'Account'>;
export type ForeignCurrency = Schema<'OpenAccountRequest'>['currency'];

export const FOREIGN_CURRENCIES: readonly ForeignCurrency[] = ['USD', 'GBP', 'EUR'];

/** The foreign wallets this customer does not have yet, in display order. */
export function addableCurrencies(accounts: readonly Pick<Account, 'currency'>[]) {
  const held = new Set(accounts.map((a) => a.currency));
  return FOREIGN_CURRENCIES.filter((c) => !held.has(c));
}

const RECEIVE_BY: Record<ForeignCurrency, string> = {
  USD: 'US account and routing number',
  GBP: 'UK sort code and account number',
  EUR: 'IBAN and BIC',
};

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
  const addable = addableCurrencies(accounts);
  const needed = MIN_TIER_FOR.fxWallets;
  const allowed = tier !== undefined && tier >= needed;

  const openWallet = useMoneyMutation('accounts', 'open', {
    invalidates: [['accounts']],
    onSuccess: (account) => {
      haptic('success');
      toast.show({ message: `${CURRENCIES[account.currency].name} wallet ready`, tone: 'success' });
      onOpened(account);
    },
  });
  const pending = openWallet.isPending ? openWallet.variables?.body.currency : undefined;

  const body = !allowed ? (
    <View style={{ gap: spacing[4] }}>
      <EmptyState
        icon={ShieldCheck}
        title={`Verify to Tier ${needed} first`}
        message={`Dollar, pound and euro wallets need a verified BVN or NIN. You're on Tier ${tier ?? 1}.`}
      />
      <Button label="Verify my identity" onPress={onUpgrade} />
    </View>
  ) : addable.length === 0 ? (
    <EmptyState
      icon={ShieldCheck}
      title="You have every wallet"
      message="Nem Bank offers naira, dollar, pound and euro wallets, and you have them all."
    />
  ) : (
    <View style={{ gap: spacing[3] }}>
      <Text color="textMuted">
        Hold and receive money in another currency. Free to open; details are for the demo.
      </Text>
      <View>
        {addable.map((code) => {
          const currency = CURRENCIES[code];
          return (
            <ListItem
              key={code}
              leading={<Text variant="title">{currency.flag}</Text>}
              title={`${currency.name} wallet`}
              subtitle={pending === code ? 'Opening…' : `Receive with ${RECEIVE_BY[code]}`}
              accessibilityHint={`Opens a ${code} wallet`}
              disabled={openWallet.isPending}
              showChevron
              onPress={() => openWallet.mutate({ body: { currency: code } })}
            />
          );
        })}
      </View>
      {openWallet.isError && (
        <Text color="danger" accessibilityLiveRegion="polite" accessibilityRole="alert">
          {openWallet.error.problem.detail ?? "We couldn't open that wallet."} Tap it to try again.
        </Text>
      )}
    </View>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title="Add a currency wallet">
      {body}
    </BottomSheet>
  );
}
