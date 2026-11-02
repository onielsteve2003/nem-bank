import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Divider, Text } from '@/components';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { useTheme } from '@/theme';

type Props = { block: Schema<'AssistantTransactionsBlock'> };

/** Transactions the assistant found; each opens its detail like anywhere else. */
export function TransactionsBlock({ block }: Props) {
  const router = useRouter();
  const { colors, radius } = useTheme();
  const { t } = useTranslation();

  if (block.transactions.length === 0) {
    return (
      <Text variant="bodySmall" color="textMuted">
        {t('assistant.noTransactions')}
      </Text>
    );
  }

  return (
    <View style={[styles.box, { borderColor: colors.border, borderRadius: radius.md }]}>
      {block.transactions.map((tx, i) => (
        <View key={tx.id}>
          {i > 0 && <Divider />}
          <TransactionRow
            transaction={tx}
            onPress={() => router.push({ pathname: '/transactions/[id]', params: { id: tx.id } })}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
});
