import type { Schema } from '@nem/contracts';
import { CURRENCIES, negate } from '@nem/shared';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { ListItem, MoneyText, StatusPill, Text } from '@/components';
import { formatWhen } from '@/features/transactions/TransactionRow';
import { fromApiMoney } from '@/lib/money';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { conversionTitle, foreignSide } from '../history';

export type Props = { conversion: Schema<'FxConversion'>; onPress: () => void };

/** One conversion: what left above what arrived, with the foreign currency's flag. */
export const ConversionRow = memo(function ConversionRow({ conversion: c, onPress }: Props) {
  const { colors, radius } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const sell = fromApiMoney(c.sell);
  const buy = fromApiMoney(c.buy);

  return (
    <ListItem
      title={conversionTitle(c)}
      subtitle={formatWhen(c.created_at)}
      onPress={onPress}
      leading={
        <View style={[styles.flag, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
          <Text>{CURRENCIES[foreignSide(c)].flag}</Text>
        </View>
      }
      trailing={
        <View style={styles.trailing}>
          <MoneyText
            value={buy}
            variant="bodyStrong"
            color="success"
            signPositive
            masked={hidden}
            align="right"
            label="Received"
          />
          <MoneyText
            value={negate(sell)}
            variant="caption"
            color="textMuted"
            masked={hidden}
            align="right"
            label="Converted"
          />
          {c.status === 'failed' && <StatusPill status="failed" />}
        </View>
      }
    />
  );
});

const styles = StyleSheet.create({
  flag: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  trailing: { alignItems: 'flex-end', gap: 2 },
});
