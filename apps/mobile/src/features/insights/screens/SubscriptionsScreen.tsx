import { lagosToday } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Repeat } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useBalancesHidden, usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { SubscriptionRow } from '../components/SubscriptionRow';
import { paidWith } from '../subscriptions';

const SIMPLE_DETECTION =
  'Without AI we still list merchants that charged you a similar amount in three or more months.';

/**
 * Detected subscriptions (INS-4): recurring charges, next one first, what they
 * cost a month in all, and a way into the controls of the card that pays each.
 */
export function SubscriptionsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const hidden = useBalancesHidden();
  const aiOn = usePreferencesStore((s) => s.ai.smartCategories);
  const q = useRepoQuery('insights', 'listSubscriptions');
  const cards = useRepoQuery('cards', 'list');
  const today = lagosToday();
  const list = q.data;

  let body;
  if (q.isError && !list) {
    body = <ErrorState title="We couldn't check your subscriptions" onRetry={() => q.refetch()} />;
  } else if (!list) {
    body = (
      <SkeletonGroup accessibilityLabel="Looking for subscriptions">
        <Skeleton height={110} />
        <Skeleton height={260} />
      </SkeletonGroup>
    );
  } else if (list.data.length === 0) {
    body = (
      <EmptyState
        icon={Repeat}
        title="No subscriptions found"
        message="When a merchant charges you a similar amount three months running, it shows up here."
      />
    );
  } else {
    const all = cards.data?.data ?? [];
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[2] }}>
            {aiOn ? (
              <View style={styles.start}>
                <AIBadge
                  feature="Subscription detection"
                  explanation={list.ai.explanation}
                  fallback={SIMPLE_DETECTION}
                />
              </View>
            ) : (
              <Text variant="caption" color="textMuted">
                Smart detection is off · simple repeat check
              </Text>
            )}
            <Text variant="bodySmall" color="textMuted">
              {list.data.length} {list.data.length === 1 ? 'subscription' : 'subscriptions'} cost
              you
            </Text>
            <MoneyText
              value={fromApiMoney(list.monthly_total)}
              variant="amountLarge"
              masked={hidden}
              label="Subscriptions a month"
            />
            <Text variant="caption" color="textMuted">
              a month, in naira
            </Text>
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="Next charge first" />
          <Card padded={false}>
            <View accessibilityRole="list">
              {list.data.map((s, i) => (
                <View key={s.id}>
                  {i > 0 && <Divider />}
                  <SubscriptionRow
                    subscription={s}
                    paidWith={paidWith(s, all)}
                    today={today}
                    hidden={hidden}
                    onCardControls={(card) =>
                      router.dismissTo({ pathname: '/cards', params: { card } })
                    }
                  />
                </View>
              ))}
            </View>
          </Card>
        </View>
        <Text variant="caption" color="textMuted">
          To stop one, cancel it with the merchant. Freezing or locking the card stops the charge
          too, but you may still owe the merchant.
        </Text>
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Subscriptions" />}
      edges={['top', 'bottom']}
      onRefresh={() => void Promise.all([q.refetch(), cards.refetch()])}
      refreshing={q.isRefetching}
    >
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  start: { alignItems: 'flex-start' },
});
