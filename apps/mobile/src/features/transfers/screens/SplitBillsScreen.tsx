import { useRouter } from 'expo-router';
import { Receipt } from '@/components/icons';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
} from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { SendHeader } from '../components/SendHeader';
import { SplitProgress } from '../components/SplitProgress';
import { isSettled, paidCount } from '../splits';
import { useTranslation } from 'react-i18next';

/** Bills the customer has split (TRF-11), each with how much has come back. */
export function SplitBillsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const splits = useRepoQuery('moneyRequests', 'listSplitBills', { query: { limit: 50 } });
  const list = splits.data?.data;

  return (
    <Screen
      header={<SendHeader title={t('transfers.splitBills.title')} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={t('transfers.splitBills.split')}
          icon={Receipt}
          onPress={() => router.push('/send/splits/new')}
        />
      }
    >
      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title={t('transfers.splitBills.none')}
            message={t('transfers.splitBills.noneMessage')}
          />
        ) : (
          list.map((s) => {
            const { paid, of } = paidCount(s);
            return (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityLabel={t('transfers.splitBills.spoken', { title: s.title, paid, of })}
                onPress={() => router.push({ pathname: '/send/splits/[id]', params: { id: s.id } })}
              >
                <Card>
                  <View style={{ gap: spacing[3] }}>
                    <View style={[styles.row, { gap: spacing[2] }]}>
                      <View style={styles.flex}>
                        <Text variant="bodyStrong" numberOfLines={1}>
                          {s.title}
                        </Text>
                        <Text variant="caption" color="textMuted">
                          {formatDateTime(s.created_at)}
                        </Text>
                      </View>
                      {isSettled(s) && (
                        <Badge label={t('transfers.splitBill.settled')} tone="success" />
                      )}
                    </View>
                    <SplitProgress split={s} />
                  </View>
                </Card>
              </Pressable>
            );
          })
        )
      ) : splits.isError ? (
        <ErrorState title={t('transfers.splitBills.failed')} onRetry={() => splits.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel={t('transfers.splitBills.loading')}>
          <View style={{ gap: spacing[2] }}>
            <SkeletonListItem />
            <SkeletonListItem />
          </View>
        </SkeletonGroup>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
