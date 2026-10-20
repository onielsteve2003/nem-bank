import type { Schema } from '@nem/contracts';
import { isZero } from '@nem/shared';
import { Clock } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Card, Icon, MoneyText, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { coolingOffNotice } from '../amount';

type Quote = Schema<'TransferQuote'>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text color="textMuted">{label}</Text>
      {children}
    </View>
  );
}

/**
 * Fee, total and the day's limit for the amount being typed (TRF-4): the
 * customer sees the full cost before they ever reach the confirm button.
 * `updating` marks figures that belong to the previous amount.
 */
export function QuoteSummary({ quote, updating }: { quote: Quote; updating: boolean }) {
  const { spacing } = useTheme();
  const fee = fromApiMoney(quote.fee);
  const notice = coolingOffNotice(quote);
  return (
    <Card>
      <View
        style={{ gap: spacing[2], opacity: updating ? 0.6 : 1 }}
        accessibilityLiveRegion="polite"
      >
        <Row label="Fee">
          {isZero(fee) ? (
            <Text variant="bodyStrong" color="success">
              Free
            </Text>
          ) : (
            <MoneyText value={fee} variant="bodyStrong" label="Fee" />
          )}
        </Row>
        <Row label="Total from your account">
          <MoneyText value={fromApiMoney(quote.total_debit)} variant="bodyStrong" label="Total" />
        </Row>
        <Row label={`Left to send today (Tier ${quote.limits.kyc_tier})`}>
          <MoneyText
            value={fromApiMoney(quote.limits.remaining_today)}
            variant="bodyStrong"
            label="Left to send today"
          />
        </Row>
        {updating && (
          <View style={[styles.inline, { gap: spacing[2] }]}>
            <ActivityIndicator size="small" />
            <Text variant="caption" color="textMuted">
              Updating for the new amount…
            </Text>
          </View>
        )}
        {notice && (
          <View style={[styles.inline, { gap: spacing[2] }]}>
            <Icon icon={Clock} size="sm" color="warning" />
            <Text variant="bodySmall" color="warning" style={styles.flex}>
              {notice}
            </Text>
          </View>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  inline: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
