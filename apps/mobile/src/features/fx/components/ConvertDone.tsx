import type { Schema } from '@nem/contracts';
import { CheckCircle2 } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, MoneyText, Screen, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { rateLine } from '../quote';
import { useTranslation } from 'react-i18next';

export type Props = {
  conversion: Schema<'FxConversion'>;
  onDone: () => void;
  onAgain: () => void;
};

/** The conversion went through: what left, what landed and the rate it used. */
export function ConvertDone({ conversion, onDone, onAgain }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const sell = fromApiMoney(conversion.sell);
  const buy = fromApiMoney(conversion.buy);
  return (
    <Screen
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          <Button label={t('common.done')} onPress={onDone} />
          <Button label={t('fx.again')} variant="secondary" onPress={onAgain} />
        </View>
      }
    >
      <View
        style={[styles.center, { gap: spacing[3], paddingTop: spacing[10] }]}
        accessibilityLiveRegion="polite"
      >
        <Icon icon={CheckCircle2} size="xl" color="success" accessibilityLabel={t('common.done')} />
        <Text variant="title" accessibilityRole="header">
          {t('fx.converted')}
        </Text>
        <MoneyText value={buy} variant="display" label={t('fx.received')} align="center" />
        <View style={[styles.row, { gap: spacing[1] }]}>
          <Text color="textMuted">{t('common.from')}</Text>
          <MoneyText value={sell} color="textMuted" label={t('fx.converted')} />
        </View>
        <Text variant="bodySmall" color="textMuted">
          {t('fx.doneAt', { rate: rateLine(conversion.rate, sell.currency, buy.currency) })}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
});
