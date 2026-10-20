import type { Schema } from '@nem/contracts';
import { add, formatMoney, negate, zero, type Money } from '@nem/shared';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Copy, Flag, Repeat, Tag } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  BottomSheet,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Icon,
  IconButton,
  ListItem,
  MoneyText,
  Screen,
  Skeleton,
  SkeletonGroup,
  StatusPill,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { CATEGORIES, type Category } from './categories';
import { transactionTitle } from './TransactionRow';

type Detail = Schema<'TransactionDetail'>;

const TYPE_LABELS: Record<Schema<'TransactionType'>, string> = {
  transfer_in: 'Money in',
  transfer_out: 'Transfer',
  card_payment: 'Card payment',
  card_refund: 'Card refund',
  bill_payment: 'Bill payment',
  fx_conversion: 'Currency conversion',
  savings: 'Savings',
  ajo: 'Ajo',
  loan_disbursement: 'Loan paid out',
  loan_repayment: 'Loan repayment',
  interest: 'Interest',
  fee: 'Fee',
  levy: 'Levy',
  reversal: 'Reversal',
  deposit: 'Deposit',
  dispute_refund: 'Dispute refund',
};

const dateTime = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Africa/Lagos',
});
export const formatDateTime = (iso: string) => dateTime.format(new Date(iso));

/** Total of the fee lines, in the transaction's currency. */
export function totalFees(detail: Pick<Detail, 'fees' | 'amount'>): Money {
  return detail.fees.reduce<Money>(
    (sum, f) => add(sum, fromApiMoney(f.amount)),
    zero(detail.amount.currency),
  );
}

const STEP_TONE = (status: string) =>
  status === 'failed'
    ? 'danger'
    : status === 'completed' || status === 'settled'
      ? 'success'
      : 'primaryText';

function Row({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing[3], minHeight: 44 }]}>
      <Text color="textMuted" style={styles.label}>
        {label}
      </Text>
      <Text style={styles.value} selectable>
        {value}
      </Text>
      {onCopy && (
        <IconButton
          icon={Copy}
          accessibilityLabel={`Copy ${label.toLowerCase()}`}
          variant="ghost"
          size="sm"
          onPress={onCopy}
        />
      )}
    </View>
  );
}

/**
 * One transaction in full (ACC-6): amount and status, the status timeline,
 * fees, reference, an editable category, and the way into a dispute or a
 * repeat transfer when those make sense.
 */
export function TransactionDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const query = useRepoQuery('transactions', 'get', { path: { transaction_id: id } });
  const [picking, setPicking] = useState(false);
  const [similar, setSimilar] = useState(false);

  const recategorise = useRepoMutation('transactions', 'update', {
    invalidates: [['transactions'], ['insights']],
    onSuccess: (t) => {
      haptic('success');
      setPicking(false);
      toast.show({ message: `Moved to ${CATEGORIES[t.category].label}`, tone: 'success' });
    },
    onError: (e) =>
      toast.show({
        message: e.problem.detail ?? "We couldn't change the category.",
        tone: 'error',
      }),
  });

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    haptic('success');
    toast.show({ message: `${label} copied`, tone: 'success' });
  };

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <IconButton
        icon={ArrowLeft}
        accessibilityLabel="Back"
        variant="ghost"
        onPress={() => router.back()}
      />
      <Text variant="title" accessibilityRole="header">
        Transaction
      </Text>
    </View>
  );

  const t = query.data;
  if (!t) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {query.isError ? (
          <ErrorState
            kind={
              isApiError(query.error) && query.error.problem.code === 'offline'
                ? 'offline'
                : 'error'
            }
            title={
              isApiError(query.error) && query.error.problem.status === 404
                ? "We can't find that transaction"
                : "We couldn't load this transaction"
            }
            onRetry={() => void query.refetch()}
          />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading transaction">
            <Skeleton height={120} radius={24} />
            <Skeleton height={200} radius={24} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const category = CATEGORIES[t.category] ?? CATEGORIES.other;
  const amount = fromApiMoney(t.amount);
  const fees = totalFees(t);
  const them = t.counterparty;
  const account = [them.bank_name, them.account_number_masked].filter(Boolean).join(' · ');

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void query.refetch()}
      refreshing={query.isRefetching}
    >
      <View style={[styles.center, { gap: spacing[2] }]}>
        <View style={[styles.badge, { backgroundColor: colors.raised, borderRadius: radius.lg }]}>
          <Icon icon={category.icon} color="textMuted" />
        </View>
        <Text variant="bodyStrong" style={styles.centerText}>
          {transactionTitle(t)}
        </Text>
        <MoneyText
          value={t.direction === 'debit' ? negate(amount) : amount}
          variant="amountLarge"
          color={t.direction === 'credit' ? 'success' : 'text'}
          signPositive
          masked={hidden}
        />
        <StatusPill status={t.status} />
        <Text variant="caption" color="textMuted">
          {formatDateTime(t.created_at)}
        </Text>
      </View>

      <Card>
        <Text variant="label" color="textMuted" accessibilityRole="header">
          Status
        </Text>
        <View accessibilityRole="list" style={{ marginTop: spacing[3] }}>
          {t.timeline.map((step, i) => {
            const last = i === t.timeline.length - 1;
            return (
              <View
                key={`${step.status}-${step.at}`}
                style={[styles.row, styles.step]}
                accessible
                accessibilityLabel={`${step.label}, ${formatDateTime(step.at)}${step.detail ? `. ${step.detail}` : ''}`}
              >
                <View style={styles.rail}>
                  <View style={[styles.dot, { backgroundColor: colors[STEP_TONE(step.status)] }]} />
                  {!last && <View style={[styles.line, { backgroundColor: colors.border }]} />}
                </View>
                <View style={[styles.flex, { paddingBottom: last ? 0 : spacing[4] }]}>
                  <Text variant="bodyStrong">{step.label}</Text>
                  <Text variant="caption" color="textMuted">
                    {formatDateTime(step.at)}
                  </Text>
                  {step.detail && <Text variant="caption">{step.detail}</Text>}
                </View>
              </View>
            );
          })}
        </View>
      </Card>

      <Card>
        <Row label="Type" value={TYPE_LABELS[t.type]} />
        {account !== '' && (
          <Row label={t.direction === 'debit' ? 'To' : 'From'} value={`${them.name}\n${account}`} />
        )}
        {them.nemtag && <Row label="Nemtag" value={`@${them.nemtag}`} />}
        {t.narration !== '' && <Row label="Narration" value={t.narration} />}
        <Row
          label="Reference"
          value={t.reference}
          onCopy={() => void copy('Reference', t.reference)}
        />
        {t.fees.map((f) => (
          <Row
            key={f.code}
            label={f.label}
            value={hidden ? '••••' : formatMoney(fromApiMoney(f.amount))}
          />
        ))}
        {t.fees.length > 1 && (
          <Row label="Total fees" value={hidden ? '••••' : formatMoney(fees)} />
        )}
        {t.balance_after && (
          <Row
            label="Balance after"
            value={hidden ? '••••' : formatMoney(fromApiMoney(t.balance_after))}
          />
        )}
      </Card>

      <ListItem
        leading={Tag}
        title="Category"
        subtitle={`${category.label}${t.category_source === 'user' ? ' · set by you' : ''}`}
        accessibilityHint="Change the category"
        showChevron
        onPress={() => setPicking(true)}
      />

      <View style={{ gap: spacing[3] }}>
        {t.can_repeat && (
          <Button
            label="Send again"
            icon={Repeat}
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/send', params: { repeat: t.transfer_id ?? t.id } })
            }
          />
        )}
        {t.dispute_id ? (
          <Text color="textMuted" style={styles.centerText}>
            {"You've reported a problem with this payment. We'll update you here."}
          </Text>
        ) : (
          t.can_dispute && (
            <Button
              label="Report a problem"
              icon={Flag}
              variant="ghost"
              onPress={() =>
                router.push({ pathname: '/disputes/new', params: { transaction: t.id } })
              }
            />
          )
        )}
      </View>

      {picking && (
        <BottomSheet open onClose={() => setPicking(false)} title="Choose a category">
          <View style={{ gap: spacing[3] }}>
            <Checkbox
              label={`Also for every payment with ${them.name}`}
              checked={similar}
              onChange={setSimilar}
            />
            <View>
              {(Object.keys(CATEGORIES) as Category[]).map((c) => (
                <ListItem
                  key={c}
                  leading={CATEGORIES[c].icon}
                  title={CATEGORIES[c].label}
                  trailing={c === t.category ? <Text color="primaryText">Current</Text> : undefined}
                  disabled={recategorise.isPending}
                  onPress={() =>
                    c === t.category && !similar
                      ? setPicking(false)
                      : recategorise.mutate({
                          path: { transaction_id: t.id },
                          body: { category: c, apply_to_similar: similar },
                        })
                  }
                />
              ))}
            </View>
          </View>
        </BottomSheet>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  step: { alignItems: 'stretch' },
  label: { width: 112 },
  value: { flex: 1, textAlign: 'right' },
  flex: { flex: 1 },
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
  badge: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  rail: { width: 24, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  line: { width: 2, flex: 1, marginTop: 2 },
});
