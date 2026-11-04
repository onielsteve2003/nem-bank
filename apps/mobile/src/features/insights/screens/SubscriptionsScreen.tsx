import { lagosToday } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Repeat } from '@/components/icons';
import { useTranslation } from 'react-i18next';
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

/**
 * Detected subscriptions (INS-4): recurring charges, next one first, what they
 * cost a month in all, and a way into the controls of the card that pays each.
 */
export function SubscriptionsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const hidden = useBalancesHidden();
  const aiOn = usePreferencesStore((s) => s.ai.smartCategories);
  const q = useRepoQuery('insights', 'listSubscriptions');
  const cards = useRepoQuery('cards', 'list');
  const today = lagosToday();
  const list = q.data;

  let body;
  if (q.isError && !list) {
    body = <ErrorState title={t('insights.subscriptions.failed')} onRetry={() => q.refetch()} />;
  } else if (!list) {
    body = (
      <SkeletonGroup accessibilityLabel={t('insights.subscriptions.loading')}>
        <Skeleton height={110} />
        <Skeleton height={260} />
      </SkeletonGroup>
    );
  } else if (list.data.length === 0) {
    body = (
      <EmptyState
        icon={Repeat}
        title={t('insights.subscriptions.emptyTitle')}
        message={t('insights.subscriptions.emptyMessage')}
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
                  feature={t('insights.subscriptions.aiFeature')}
                  explanation={list.ai.explanation}
                  fallback={t('insights.subscriptions.simple')}
                />
              </View>
            ) : (
              <Text variant="caption" color="textMuted">
                {t('insights.subscriptions.aiOff')}
              </Text>
            )}
            <Text variant="bodySmall" color="textMuted">
              {t('insights.subscriptions.costYou', { count: list.data.length })}
            </Text>
            <MoneyText
              value={fromApiMoney(list.monthly_total)}
              variant="amountLarge"
              masked={hidden}
              label={t('insights.subscriptions.perMonth')}
            />
            <Text variant="caption" color="textMuted">
              {t('insights.subscriptions.monthNaira')}
            </Text>
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('insights.subscriptions.nextFirst')} />
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
          {t('insights.subscriptions.howToStop')}
        </Text>
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('insights.subscriptions.title')} />}
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
