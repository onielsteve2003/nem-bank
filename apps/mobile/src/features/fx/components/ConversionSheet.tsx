import type { Schema } from '@nem/contracts';
import { isZero } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ArrowDownLeft, ArrowUpRight } from '@/components/icons';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, MoneyText, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { conversionTitle } from '../history';
import { rateLine } from '../quote';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
            <Row label={t('fx.converted')}>
              <MoneyText
                value={fromApiMoney(c.sell)}
                variant="bodyStrong"
                label={t('fx.converted')}
              />
            </Row>
            <Row label={t('fx.received')}>
              <MoneyText
                value={fromApiMoney(c.buy)}
                variant="bodyStrong"
                color="success"
                label={t('fx.received')}
              />
            </Row>
            <Row label={t('fx.rate')}>
              <Text variant="bodyStrong">{rateLine(c.rate, c.sell.currency, c.buy.currency)}</Text>
            </Row>
            <Row label={t('common.fee')}>
              {isZero(fromApiMoney(c.fee)) ? (
                <Text variant="bodyStrong">{t('common.free')}</Text>
              ) : (
                <MoneyText
                  value={fromApiMoney(c.fee)}
                  variant="bodyStrong"
                  label={t('common.fee')}
                />
              )}
            </Row>
            <Row label={t('common.status')}>
              <Text variant="bodyStrong" color={c.status === 'failed' ? 'danger' : 'text'}>
                {c.status === 'failed' ? t('common.failed') : t('common.completed')}
              </Text>
            </Row>
            <Row label={t('fx.when')}>
              <Text variant="bodyStrong">{fullDate.format(new Date(c.created_at))}</Text>
            </Row>
          </View>
          <Text variant="caption" color="textMuted">
            {t('fx.spreadNote')}
          </Text>
          <View style={{ gap: spacing[2] }}>
            <Button
              label={t('fx.walletEntry', { currency: c.sell.currency })}
              icon={ArrowUpRight}
              variant="secondary"
              onPress={() => open(c.debit_transaction_id)}
            />
            <Button
              label={t('fx.walletEntry', { currency: c.buy.currency })}
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
