import type { Schema } from '@nem/contracts';
import { isZero } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, MoneyText, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { conversionTitle } from '../history';
import { rateLine } from '../quote';

const fullDate = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Africa/Lagos',
});

export type Props = { conversion: Schema<'FxConversion'> | null; onClose: () => void };

/** One conversion in full (FX-4), with a way to each wallet's side of it. */
export function ConversionSheet({ conversion: c, onClose }: Props) {
  const router = useRouter();
  const { colors, spacing, radius } = useTheme();
  const open = (id: string) => {
    onClose();
    router.push(`/transactions/${id}`);
  };

  return (
    <BottomSheet open={c !== null} onClose={onClose} title={c ? conversionTitle(c) : undefined}>
      {c && (
        <View style={{ gap: spacing[4] }}>
          <View
            style={{
              borderRadius: radius.lg,
              backgroundColor: colors.raised,
              padding: spacing[4],
              gap: spacing[3],
            }}
          >
            <Row label="Converted">
              <MoneyText value={fromApiMoney(c.sell)} variant="bodyStrong" label="Converted" />
            </Row>
            <Row label="Received">
              <MoneyText
                value={fromApiMoney(c.buy)}
                variant="bodyStrong"
                color="success"
                label="Received"
              />
            </Row>
            <Row label="Rate">
              <Text variant="bodyStrong">{rateLine(c.rate, c.sell.currency, c.buy.currency)}</Text>
            </Row>
            <Row label="Fee">
              {isZero(fromApiMoney(c.fee)) ? (
                <Text variant="bodyStrong">Free</Text>
              ) : (
                <MoneyText value={fromApiMoney(c.fee)} variant="bodyStrong" label="Fee" />
              )}
            </Row>
            <Row label="Status">
              <Text variant="bodyStrong" color={c.status === 'failed' ? 'danger' : 'text'}>
                {c.status === 'failed' ? 'Failed' : 'Completed'}
              </Text>
            </Row>
            <Row label="When">
              <Text variant="bodyStrong">{fullDate.format(new Date(c.created_at))}</Text>
            </Row>
          </View>
          <Text variant="caption" color="textMuted">
            The spread is built into the rate; it was shown before you confirmed.
          </Text>
          <View style={{ gap: spacing[2] }}>
            <Button
              label={`${c.sell.currency} wallet entry`}
              icon={ArrowUpRight}
              variant="secondary"
              onPress={() => open(c.debit_transaction_id)}
            />
            <Button
              label={`${c.buy.currency} wallet entry`}
              icon={ArrowDownLeft}
              variant="secondary"
              onPress={() => open(c.credit_transaction_id)}
            />
          </View>
        </View>
      )}
    </BottomSheet>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing[2] }]}>
      <Text color="textMuted">{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
