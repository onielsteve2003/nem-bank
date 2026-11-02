import type { Schema } from '@nem/contracts';
import { Wallet } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button, Card, Divider, SectionHeader, Text } from '@/components';
import { useTheme } from '@/theme';

import { sortBudgets } from '../budgets';
import { BudgetRow } from './BudgetRow';

/** How many budgets Insights shows before "Manage". */
const SHOWN = 3;

export type Props = {
  budgets: readonly Schema<'Budget'>[];
  hidden: boolean;
  onManage: () => void;
};

/** This month's budgets on Insights, the ones needing attention first (INS-2). */
export function BudgetsSummary({ budgets, hidden, onManage }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const shown = sortBudgets(budgets).slice(0, SHOWN);
  return (
    <View style={{ gap: spacing[2] }}>
      <SectionHeader
        title={t('insights.budgets.title')}
        actionLabel={budgets.length > 0 ? t('insights.budgets.manage') : undefined}
        onAction={onManage}
      />
      {shown.length === 0 ? (
        <Card>
          <View style={{ gap: spacing[3] }}>
            <Text variant="body" color="textMuted">
              {t('insights.budgets.intro')}
            </Text>
            <Button
              label={t('insights.budgets.set')}
              icon={Wallet}
              variant="secondary"
              onPress={onManage}
            />
          </View>
        </Card>
      ) : (
        <Card padded={false}>
          <View accessibilityRole="list">
            {shown.map((b, i) => (
              <View key={b.id}>
                {i > 0 && <Divider />}
                <BudgetRow budget={b} hidden={hidden} onPress={onManage} />
              </View>
            ))}
          </View>
        </Card>
      )}
    </View>
  );
}
