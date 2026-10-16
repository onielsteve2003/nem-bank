import { add, money } from '@nem/shared';
import { Eye, EyeOff, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  IconButton,
  MoneyText,
  STATUS_META,
  StatusPill,
  Text,
  type TransactionStatus,
} from '@/components';
import { useTheme } from '@/theme';

import { KitSection } from './KitSection';

const STATUSES = Object.keys(STATUS_META) as TransactionStatus[];

export function MoneySection() {
  const { spacing } = useTheme();
  const [balance, setBalance] = useState(money(24_850_000n, 'NGN'));
  const [masked, setMasked] = useState(false);

  return (
    <KitSection title="Money and status">
      <Card>
        <View style={styles.row}>
          <Text variant="label" color="textMuted">
            Available balance
          </Text>
          <IconButton
            icon={masked ? Eye : EyeOff}
            variant="ghost"
            accessibilityLabel={masked ? 'Show balance' : 'Hide balance'}
            onPress={() => setMasked((m) => !m)}
          />
        </View>
        <MoneyText
          value={balance}
          variant="amountLarge"
          label="Available balance"
          masked={masked}
          animate
        />
        <Button
          label="Receive ₦12,500"
          icon={Plus}
          variant="secondary"
          size="sm"
          onPress={() => setBalance((b) => add(b, money(1_250_000n, 'NGN')))}
        />
      </Card>
      <View style={{ gap: spacing[1] }}>
        <MoneyText value={money(1_200_000n, 'NGN')} colorBySign signPositive />
        <MoneyText value={money(-450_000n, 'NGN')} colorBySign />
        <MoneyText value={money(2_599n, 'USD')} variant="bodyStrong" />
      </View>
      <View style={[styles.wrap, { gap: spacing[2] }]}>
        {STATUSES.map((s) => (
          <StatusPill key={s} status={s} />
        ))}
      </View>
    </KitSection>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
