import type { Schema } from '@nem/contracts';
import { CURRENCIES, isPositive, negate } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import {
  BottomSheet,
  Divider,
  ErrorState,
  MoneyText,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { balanceBreakdown, HOLD_REASONS } from './balance';

export type Props = { account: Schema<'Account'>; hidden: boolean; onClose: () => void };

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing[3], minHeight: 44 }]}>
      <Text style={styles.flex}>{label}</Text>
      {children}
    </View>
  );
}

/**
 * Available vs ledger balance (ACC-3): the posted balance, each hold that
 * reserves part of it, and what is left to spend. Amounts follow privacy mode.
 */
export function BalanceExplainerSheet({ account, hidden, onClose }: Props) {
  const { spacing, colors, radius } = useTheme();
  const holds = useRepoQuery('accounts', 'listHolds', { path: { account_id: account.id } });
  const b = balanceBreakdown(account, holds.data?.data ?? []);
  const currency = CURRENCIES[account.currency];

  return (
    <BottomSheet open onClose={onClose} title={`${currency.flag} ${currency.name} balance`}>
      <View style={{ gap: spacing[4] }}>
        <Text color="textMuted">
          Your ledger balance counts every payment that has posted. Some of it can be held for
          payments that are not final yet. What is left is your available balance, the amount you
          can spend now.
        </Text>

        <View
          style={{ backgroundColor: colors.raised, borderRadius: radius.lg, padding: spacing[4] }}
        >
          <Line label="Ledger balance">
            <MoneyText value={b.ledger} masked={hidden} />
          </Line>

          {holds.data ? (
            holds.data.data.length === 0 && !isPositive(b.unlisted) ? (
              <Text variant="caption" color="textMuted" style={{ paddingVertical: spacing[2] }}>
                Nothing is on hold right now.
              </Text>
            ) : (
              <View accessibilityRole="list">
                {holds.data.data.map((h) => (
                  <View
                    key={h.id}
                    style={[styles.row, { gap: spacing[3], paddingVertical: spacing[2] }]}
                  >
                    <View style={styles.flex}>
                      <Text variant="caption">{h.description ?? HOLD_REASONS[h.reason]}</Text>
                      <Text variant="caption" color="textMuted">
                        {h.expires_at
                          ? `Releases by ${formatDateTime(h.expires_at)} if it does not go through`
                          : `Since ${formatDateTime(h.created_at)}`}
                      </Text>
                    </View>
                    <MoneyText
                      value={negate(fromApiMoney(h.amount))}
                      variant="caption"
                      color="textMuted"
                      masked={hidden}
                    />
                  </View>
                ))}
                {isPositive(b.unlisted) && (
                  <View style={[styles.row, { gap: spacing[3], paddingVertical: spacing[2] }]}>
                    <Text variant="caption" style={styles.flex}>
                      Other holds being updated
                    </Text>
                    <MoneyText
                      value={negate(b.unlisted)}
                      variant="caption"
                      color="textMuted"
                      masked={hidden}
                    />
                  </View>
                )}
              </View>
            )
          ) : holds.isError ? (
            <ErrorState title="We couldn't load the holds" onRetry={() => void holds.refetch()} />
          ) : (
            <SkeletonGroup accessibilityLabel="Loading holds">
              <Skeleton height={40} />
            </SkeletonGroup>
          )}

          <Divider />
          <Line label="Available to spend">
            <MoneyText value={b.available} variant="bodyStrong" masked={hidden} />
          </Line>
        </View>

        <Text variant="caption" color="textMuted">
          Holds end on their own: a card payment settles or drops off, a transfer completes or the
          money comes back.
        </Text>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
