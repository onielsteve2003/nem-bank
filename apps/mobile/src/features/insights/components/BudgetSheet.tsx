import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountInput, BottomSheet, Button, Chip, Dialog, Text } from '@/components';
import { isApiError } from '@/data';
import { CATEGORIES, type Category } from '@/features/transactions/categories';
import { typedFromKobo, typedNaira } from '@/features/transfers/amount';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

export type Props = {
  /** Change this budget; without one, the sheet creates a new budget. */
  budget?: Schema<'Budget'>;
  /** Categories a new budget can cover. */
  categories: readonly Category[];
  onClose: () => void;
};

/** Smallest budget worth tracking: anything under ₦1,000 alerts on the first spend. */
const MIN_LIMIT_KOBO = 100_000n;

/**
 * Create a budget for a category, or change or remove one (INS-2). Alerts at
 * 80% and 100% come with every budget. Mount it only while open.
 */
export function BudgetSheet({ budget, categories, onClose }: Props) {
  const { spacing } = useTheme();
  const [category, setCategory] = useState<Category | null>(budget?.category ?? null);
  const [typed, setTyped] = useState(
    budget ? typedFromKobo(BigInt(budget.limit.amount_minor)) : '',
  );
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const opts = { invalidates: [['insights']] };
  const create = useRepoMutation('insights', 'createBudget', opts);
  const update = useRepoMutation('insights', 'updateBudget', opts);
  const remove = useRepoMutation('insights', 'deleteBudget', opts);

  const amount = typedNaira(typed);
  const tooSmall = amount !== null && amount.amount < MIN_LIMIT_KOBO;
  const name = category ? CATEGORIES[category].label : null;
  const failed = (e: unknown) =>
    setError(
      isApiError(e) && e.code === 'budget_exists'
        ? 'You already have a budget for this category.'
        : "We couldn't save it. Try again.",
    );

  const save = () => {
    if (!amount || !category) return;
    setError(undefined);
    const limit = toApiMoney(amount);
    if (budget) {
      update.mutate(
        { path: { budget_id: budget.id }, body: { limit } },
        { onSuccess: onClose, onError: failed },
      );
    } else {
      create.mutate({ body: { category, limit } }, { onSuccess: onClose, onError: failed });
    }
  };

  return (
    <>
      <BottomSheet
        open={!removing}
        onClose={onClose}
        title={budget ? `${name} budget` : category ? 'Set a monthly limit' : 'Budget for what?'}
      >
        <View style={{ gap: spacing[4] }}>
          {!category ? (
            // Step one: the category. The keypad comes after, so the sheet stays short.
            <View style={[styles.wrap, { gap: spacing[2] }]}>
              {categories.map((c) => (
                <Chip
                  key={c}
                  label={CATEGORIES[c].label}
                  icon={CATEGORIES[c].icon}
                  onPress={() => setCategory(c)}
                />
              ))}
            </View>
          ) : (
            <>
              {!budget && (
                <View style={styles.start}>
                  <Chip
                    label={CATEGORIES[category].label}
                    icon={CATEGORIES[category].icon}
                    selected
                    onRemove={() => setCategory(null)}
                  />
                </View>
              )}
              <AmountInput
                currency="NGN"
                label="Monthly limit"
                value={typed}
                onChangeValue={setTyped}
                maxWholeDigits={9}
                help={
                  budget
                    ? `${formatMoney(fromApiMoney(budget.spent))} spent this month`
                    : 'We’ll tell you at 80% and again at 100%.'
                }
                error={tooSmall ? 'Set at least ₦1,000' : undefined}
              />
              {error && (
                <Text variant="bodySmall" color="danger" accessibilityRole="alert">
                  {error}
                </Text>
              )}
              <Button
                label={budget ? 'Save budget' : `Add ${name?.toLowerCase()} budget`}
                disabled={!amount || tooSmall}
                loading={create.isPending || update.isPending}
                onPress={save}
              />
            </>
          )}
          {budget && (
            <Button label="Remove budget" variant="ghost" onPress={() => setRemoving(true)} />
          )}
        </View>
      </BottomSheet>
      {budget && (
        <Dialog
          open={removing}
          title={`Remove your ${name?.toLowerCase()} budget?`}
          message="You’ll stop getting alerts for it. Your spending isn’t affected."
          confirmLabel="Remove"
          destructive
          loading={remove.isPending}
          onCancel={() => setRemoving(false)}
          onConfirm={() =>
            remove.mutate(
              { path: { budget_id: budget.id } },
              {
                onSuccess: onClose,
                onError: (e) => {
                  setRemoving(false);
                  failed(e);
                },
              },
            )
          }
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  start: { alignItems: 'flex-start' },
});
