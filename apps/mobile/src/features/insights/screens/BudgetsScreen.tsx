import type { Schema } from '@nem/contracts';
import { Plus, Wallet } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { useBalancesHidden } from '@/stores';
import { useTheme } from '@/theme';

import { budgetableCategories, sortBudgets } from '../budgets';
import { BudgetRow } from '../components/BudgetRow';
import { BudgetSheet } from '../components/BudgetSheet';

/**
 * Budgets (INS-2): a monthly limit per category, with this month's spend
 * against it. The bank sends an alert at 80% and again at 100%.
 */
export function BudgetsScreen() {
  const { spacing } = useTheme();
  const hidden = useBalancesHidden();
  const budgets = useRepoQuery('insights', 'listBudgets');
  // undefined = closed, null = a new budget.
  const [editing, setEditing] = useState<Schema<'Budget'> | null>();
  const list = budgets.data ? sortBudgets(budgets.data.data) : [];
  const free = budgets.data ? budgetableCategories(budgets.data.data) : [];

  let body;
  if (budgets.isError && !budgets.data) {
    body = <ErrorState title="We couldn't load your budgets" onRetry={() => budgets.refetch()} />;
  } else if (!budgets.data) {
    body = (
      <SkeletonGroup accessibilityLabel="Loading your budgets">
        <Skeleton height={96} />
        <Skeleton height={96} />
      </SkeletonGroup>
    );
  } else if (list.length === 0) {
    body = (
      <EmptyState
        icon={Wallet}
        title="No budgets yet"
        message="Set a monthly limit for a category and we’ll tell you at 80% and again at 100%."
        actionLabel="Add a budget"
        onAction={() => setEditing(null)}
      />
    );
  } else {
    body = (
      <>
        <Card padded={false}>
          <View accessibilityRole="list">
            {list.map((b, i) => (
              <View key={b.id}>
                {i > 0 && <Divider />}
                <BudgetRow budget={b} hidden={hidden} onPress={() => setEditing(b)} />
              </View>
            ))}
          </View>
        </Card>
        <Text variant="caption" color="textMuted">
          Budgets reset on the 1st of each month. Money moved into your own savings doesn’t count.
        </Text>
        {free.length > 0 && (
          <Button
            label="Add a budget"
            icon={Plus}
            variant="secondary"
            onPress={() => setEditing(null)}
          />
        )}
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Budgets" />}
      edges={['top', 'bottom']}
      onRefresh={() => void budgets.refetch()}
      refreshing={budgets.isRefetching}
    >
      <View style={{ gap: spacing[4] }}>{body}</View>
      {editing !== undefined && (
        <BudgetSheet
          budget={editing ?? undefined}
          categories={free}
          onClose={() => setEditing(undefined)}
        />
      )}
    </Screen>
  );
}
