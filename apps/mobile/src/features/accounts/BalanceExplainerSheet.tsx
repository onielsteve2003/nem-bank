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
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={t('accounts.balance.title', { flag: currency.flag, name: currency.name })}
    >
      <View style={{ gap: spacing[4] }}>
        <Text color="textMuted">{t('accounts.balance.intro')}</Text>

        <View
          style={{ backgroundColor: colors.raised, borderRadius: radius.lg, padding: spacing[4] }}
        >
          <Line label={t('accounts.balance.ledger')}>
            <MoneyText value={b.ledger} masked={hidden} />
          </Line>

          {holds.data ? (
            holds.data.data.length === 0 && !isPositive(b.unlisted) ? (
              <Text variant="caption" color="textMuted" style={{ paddingVertical: spacing[2] }}>
                {t('accounts.balance.nothingHeld')}
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
                          ? t('accounts.balance.releasesBy', { time: formatDateTime(h.expires_at) })
                          : t('accounts.balance.since', { time: formatDateTime(h.created_at) })}
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
                      {t('accounts.balance.otherHolds')}
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
            <ErrorState
              title={t('accounts.balance.holdsFailed')}
              onRetry={() => void holds.refetch()}
            />
          ) : (
            <SkeletonGroup accessibilityLabel={t('accounts.balance.loadingHolds')}>
              <Skeleton height={40} />
            </SkeletonGroup>
          )}

          <Divider />
          <Line label={t('accounts.balance.available')}>
            <MoneyText value={b.available} variant="bodyStrong" masked={hidden} />
          </Line>
        </View>

        <Text variant="caption" color="textMuted">
          {t('accounts.balance.holdsEnd')}
        </Text>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
