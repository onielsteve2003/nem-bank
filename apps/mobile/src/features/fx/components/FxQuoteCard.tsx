import type { Schema } from '@nem/contracts';
import { isZero } from '@nem/shared';
import { RefreshCw, Timer } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Card, Divider, Icon, MoneyText, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { formatCountdown } from '@/features/auth/otp';

import { rateLine, spreadCost, spreadPercent } from '../quote';
import { useTranslation } from 'react-i18next';

type Quote = Schema<'FxQuote'>;

export type Props = {
  quote: Quote;
  /** Seconds the rate is still held for; 0 once it has expired. */
  secondsLeft: number;
  /** The quote shown belongs to the previous amount while the new one loads. */
  updating: boolean;
  onRequote: () => void;
  requoting: boolean;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text color="textMuted" style={styles.flex}>
        {label}
      </Text>
      {children}
    </View>
  );
}

/**
 * The full price of a conversion (FX-1): the customer's rate against the
 * mid-market rate, what the spread costs in money, the fee and what lands, with
 * the 60-second hold counting down. An expired rate asks for a new one; it is
 * never swapped silently under the customer's thumb.
 */
export function FxQuoteCard({ quote, secondsLeft, updating, onRequote, requoting }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const sell = fromApiMoney(quote.sell);
  const buy = fromApiMoney(quote.buy);
  const fee = fromApiMoney(quote.fee);
  const expired = secondsLeft === 0;

  return (
    <Card>
      <View style={{ gap: spacing[2], opacity: updating ? 0.6 : 1 }}>
        <Row label={t('fx.yourRate')}>
          <Text variant="bodyStrong">{rateLine(quote.rate, sell.currency, buy.currency)}</Text>
        </Row>
        <Row label={t('fx.midRate')}>
          <Text color="textMuted">{rateLine(quote.mid_rate, sell.currency, buy.currency)}</Text>
        </Row>
        <Row label={t('fx.spread', { percent: spreadPercent(quote.spread_bps) })}>
          <MoneyText value={spreadCost(quote)} label={t('fx.spreadCost')} />
        </Row>
        <Row label={t('common.fee')}>
          {isZero(fee) ? (
            <Text variant="bodyStrong" color="success">
              {t('common.free')}
            </Text>
          ) : (
            <MoneyText value={fee} variant="bodyStrong" label={t('common.fee')} />
          )}
        </Row>
        <Divider />
        <Row label={t('fx.youGet')}>
          <MoneyText value={buy} variant="title" label={t('fx.youGet')} />
        </Row>

        {updating ? (
          <View style={[styles.inline, { gap: spacing[2] }]}>
            <ActivityIndicator size="small" />
            <Text variant="caption" color="textMuted">
              {t('fx.requoting')}
            </Text>
          </View>
        ) : expired ? (
          <View style={{ gap: spacing[2] }} accessibilityLiveRegion="polite">
            <View style={[styles.inline, { gap: spacing[2] }]}>
              <Icon icon={Timer} size="sm" color="warning" />
              <Text variant="bodySmall" color="warning" style={styles.flex}>
                {t('fx.expired')}
              </Text>
            </View>
            <Button
              label={t('fx.newRate')}
              icon={RefreshCw}
              variant="secondary"
              size="sm"
              loading={requoting}
              onPress={onRequote}
            />
          </View>
        ) : (
          <View
            style={[styles.inline, { gap: spacing[2] }]}
            accessible
            accessibilityLabel={t('fx.heldFor', { seconds: secondsLeft })}
          >
            <Icon icon={Timer} size="sm" color={secondsLeft <= 10 ? 'warning' : 'textMuted'} />
            <Text variant="caption" color={secondsLeft <= 10 ? 'warning' : 'textMuted'}>
              {t('fx.heldForShort', { time: formatCountdown(secondsLeft) })}
            </Text>
          </View>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
