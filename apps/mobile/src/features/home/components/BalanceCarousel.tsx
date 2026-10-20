import type { Schema } from '@nem/contracts';
import { CURRENCIES, formatMoney, isPositive, subtract } from '@nem/shared';
import { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { ChevronRight, Plus } from 'lucide-react-native';

import { Icon, MoneyText, Text } from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

const DOT = 6;
const DOT_ACTIVE = 18;
/** The next card peeks in from the right, so it is obvious there is more to swipe. */
const PEEK = 24;

export type Account = Schema<'Account'>;

/** "0123456789" → "•••• 6789": enough to tell accounts apart on a shared screen. */
export function accountTail(account: Account): string | null {
  const details = account.receiving_details as { account_number?: string; iban?: string };
  const number = details.account_number ?? details.iban;
  return number ? `•••• ${number.replace(/\s/g, '').slice(-4)}` : null;
}

/**
 * One card per currency wallet: available balance large, with what is on hold
 * under it (ACC-3). Width comes from layout, not the window, so it pages
 * correctly inside the web demo's phone frame. Each card is its own screen
 * reader stop, read as one sentence.
 */
export function BalanceCarousel({
  accounts,
  hidden,
  onOpen,
  onAdd,
}: {
  accounts: readonly Account[];
  hidden: boolean;
  onOpen?: (account: Account) => void;
  /** Shows a last "Add wallet" card (ACC-2) while there are currencies left to add. */
  onAdd?: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const cards = accounts.length + (onAdd ? 1 : 0);
  const cardWidth = cards > 1 ? Math.max(0, width - PEEK - spacing[4]) : width - spacing[4] * 2;
  const step = cardWidth + spacing[3];

  // onScroll rather than onMomentumScrollEnd: browsers never send momentum events.
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (step <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / step);
    if (next !== index && next >= 0 && next < cards) setIndex(next);
  };

  return (
    <View
      testID="balance-carousel"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ gap: spacing[3] }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={step > 0 ? step : undefined}
        decelerationRate="fast"
        onScroll={onScroll}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingHorizontal: spacing[4], gap: spacing[3] }}
      >
        {width > 0 &&
          accounts.map((account, i) => {
            const currency = CURRENCIES[account.currency];
            const available = fromApiMoney(account.available_balance);
            const onHold = subtract(fromApiMoney(account.ledger_balance), available);
            const tail = accountTail(account);
            const primary = i === 0;
            const fg = primary ? 'onPrimary' : 'text';
            const muted = primary ? 'onPrimary' : 'textMuted';
            const label = [
              `${currency.name} wallet${tail ? `, ending ${tail.slice(-4)}` : ''}`,
              `Available balance ${hidden ? 'hidden' : formatMoney(available)}`,
              isPositive(onHold) && !hidden ? `${formatMoney(onHold)} on hold` : null,
            ]
              .filter(Boolean)
              .join('. ');
            return (
              <Pressable
                key={account.id}
                testID={`balance-${account.currency}`}
                accessible
                accessibilityRole={onOpen ? 'button' : 'summary'}
                accessibilityLabel={label}
                accessibilityHint={onOpen ? 'Shows account details' : undefined}
                disabled={!onOpen}
                onPress={onOpen ? () => onOpen(account) : undefined}
                style={({ pressed }) => [
                  styles.card,
                  {
                    width: cardWidth,
                    borderRadius: radius.xl,
                    padding: spacing[5],
                    gap: spacing[2],
                    backgroundColor: primary ? colors.primary : colors.raised,
                    borderColor: colors.border,
                    borderWidth: primary ? 0 : StyleSheet.hairlineWidth,
                    opacity: pressed ? 0.9 : 1,
                  },
                ]}
              >
                <View style={styles.row}>
                  <Text variant="label" color={muted}>
                    {currency.flag} {account.nickname ?? currency.name}
                  </Text>
                  {tail && (
                    <Text variant="caption" color={muted}>
                      {tail}
                    </Text>
                  )}
                </View>
                <Text variant="caption" color={muted}>
                  Available balance
                </Text>
                <MoneyText
                  value={available}
                  variant="amountLarge"
                  color={fg}
                  masked={hidden}
                  animate
                />
                {isPositive(onHold) && (
                  <View style={[styles.row, { justifyContent: 'flex-start', gap: spacing[1] }]}>
                    <MoneyText value={onHold} variant="caption" color={muted} masked={hidden} />
                    <Text variant="caption" color={muted}>
                      on hold
                    </Text>
                  </View>
                )}
                {onOpen && (
                  <View
                    style={[styles.row, { justifyContent: 'flex-start', marginTop: spacing[1] }]}
                  >
                    <Text variant="caption" color={muted}>
                      Account details
                    </Text>
                    <Icon icon={ChevronRight} size="sm" color={muted} />
                  </View>
                )}
              </Pressable>
            );
          })}
        {width > 0 && onAdd && (
          <Pressable
            testID="balance-add"
            accessibilityRole="button"
            accessibilityLabel="Add a currency wallet"
            accessibilityHint="Dollar, pound or euro"
            onPress={onAdd}
            style={({ pressed }) => [
              styles.card,
              styles.add,
              {
                width: cardWidth,
                borderRadius: radius.xl,
                padding: spacing[5],
                gap: spacing[2],
                borderColor: colors.border,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Icon icon={Plus} size="lg" color="primaryText" />
            <Text variant="label">Add a currency wallet</Text>
            <Text variant="caption" color="textMuted">
              Dollar, pound or euro
            </Text>
          </Pressable>
        )}
      </ScrollView>

      {cards > 1 && (
        <View
          style={[styles.dots, { gap: spacing[1] }]}
          accessible
          accessibilityLabel={`Card ${index + 1} of ${cards}`}
        >
          {Array.from({ length: cards }, (_, i) => (
            <View
              key={i}
              style={{
                width: i === index ? DOT_ACTIVE : DOT,
                height: DOT,
                borderRadius: DOT / 2,
                backgroundColor: i === index ? colors.primaryText : colors.border,
              }}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { minHeight: 148, justifyContent: 'flex-end' },
  add: { borderWidth: 1, borderStyle: 'dashed', alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dots: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
});
