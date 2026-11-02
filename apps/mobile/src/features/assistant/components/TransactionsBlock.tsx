import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Divider, Text } from '@/components';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { useTheme } from '@/theme';

type Props = { block: Schema<'AssistantTransactionsBlock'> };

/** Transactions the assistant found; each opens its detail like anywhere else. */
export function TransactionsBlock({ block }: Props) {
  const router = useRouter();
  const { colors, radius } = useTheme();

  if (block.transactions.length === 0) {
    return (
      <Text variant="bodySmall" color="textMuted">
        No transactions to show.
      </Text>
    );
  }

  return (
    <View style={[styles.box, { borderColor: colors.border, borderRadius: radius.md }]}>
      {block.transactions.map((t, i) => (
        <View key={t.id}>
          {i > 0 && <Divider />}
          <TransactionRow
            transaction={t}
            onPress={() => router.push({ pathname: '/transactions/[id]', params: { id: t.id } })}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});
