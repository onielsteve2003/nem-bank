import type { Schema } from '@nem/contracts';
import { negate } from '@nem/shared';
import { StyleSheet, View } from 'react-native';

import { Icon, ListItem, MoneyText, StatusPill } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { CATEGORIES } from './categories';

const timeFormat = new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('en-NG', { day: 'numeric', month: 'short' });

const lagosDay = (date: Date) => new Date(date.getTime() + 3_600_000).toISOString().slice(0, 10);

/** "Today, 2:14 pm", "Yesterday, 9:03 am", "12 Oct": the Lagos calendar day decides. */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const day = lagosDay(at);
  const yesterday = lagosDay(new Date(now.getTime() - 86_400_000));
  if (day === lagosDay(now)) return `Today, ${timeFormat.format(at)}`;
  if (day === yesterday) return `Yesterday, ${timeFormat.format(at)}`;
  return dayFormat.format(at);
}

/** Who or what the money went to or came from, as the list shows it. */
export function transactionTitle(t: Schema<'Transaction'>): string {
  return t.counterparty.name || t.narration;
}

/**
 * One transaction in a list: category icon, who, when, and the signed amount.
 * Credits are green with "+"; debits stay plain, so a list of spending is not a
 * wall of red. Anything not yet final carries a status pill (icon + word).
 */
export function TransactionRow({
  transaction: t,
  onPress,
  timeOnly = false,
}: {
  transaction: Schema<'Transaction'>;
  onPress?: () => void;
  /** Under a day header the date is already said, so only the time is shown. */
  timeOnly?: boolean;
}) {
  const { colors, radius } = useTheme();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const category = CATEGORIES[t.category] ?? CATEGORIES.other;
  const amount = fromApiMoney(t.amount);
  const signed = t.direction === 'debit' ? negate(amount) : amount;
  const when = timeOnly ? timeFormat.format(new Date(t.created_at)) : formatWhen(t.created_at);
  const showStatus = t.status !== 'completed';

  return (
    <ListItem
      title={transactionTitle(t)}
      subtitle={`${when} · ${category.label}`}
      leading={
        <View style={[styles.icon, { backgroundColor: colors.raised, borderRadius: radius.md }]}>
          <Icon icon={category.icon} size="sm" color="textMuted" />
        </View>
      }
      trailing={
        <View style={styles.trailing}>
          <MoneyText
            value={signed}
            variant="bodyStrong"
            color={t.direction === 'credit' ? 'success' : 'text'}
            signPositive
            masked={hidden}
            align="right"
          />
          {showStatus && <StatusPill status={t.status} />}
        </View>
      }
      onPress={onPress}
    />
  );
}

const styles = StyleSheet.create({
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  trailing: { alignItems: 'flex-end', gap: 4 },
});
