import { useRouter } from 'expo-router';
import { Receipt } from 'lucide-react-native';
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

/** Bills the customer has split (TRF-11), each with how much has come back. */
export function SplitBillsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const splits = useRepoQuery('moneyRequests', 'listSplitBills', { query: { limit: 50 } });
  const list = splits.data?.data;

  return (
    <Screen
      header={<SendHeader title="Split bills" />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label="Split a bill"
          icon={Receipt}
          onPress={() => router.push('/send/splits/new')}
        />
      }
    >
      {list ? (
        list.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No split bills yet"
            message="Paid for dinner, fuel or a trip? Split it and everyone gets a request for their share."
          />
        ) : (
          list.map((s) => {
            const { paid, of } = paidCount(s);
            return (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                accessibilityLabel={`${s.title}, ${paid} of ${of} paid`}
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
                      {isSettled(s) && <Badge label="Settled" tone="success" />}
                    </View>
                    <SplitProgress split={s} />
                  </View>
                </Card>
              </Pressable>
            );
          })
        )
      ) : splits.isError ? (
        <ErrorState title="We couldn't load your split bills" onRetry={() => splits.refetch()} />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading split bills">
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
