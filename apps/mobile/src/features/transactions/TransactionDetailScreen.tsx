import type { Schema } from '@nem/contracts';
import { add, formatMoney, negate, zero, type Money } from '@nem/shared';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ArrowLeft,
  Copy,
  Flag,
  MessageCircle,
  ReceiptText,
  Repeat,
  ShieldQuestion,
  Tag,
} from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
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
  StatusTimeline,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { CATEGORIES, categorySourceText, isUnsure, type Category } from './categories';
import { formatDateTime } from './format';
import { ReceiptSheet } from './ReceiptSheet';
import { transactionTitle } from './TransactionRow';
import { useTranslation } from 'react-i18next';

type Detail = Schema<'TransactionDetail'>;

/** Total of the fee lines, in the transaction's currency. */
export function totalFees(detail: Pick<Detail, 'fees' | 'amount'>): Money {
  return detail.fees.reduce<Money>(
    (sum, f) => add(sum, fromApiMoney(f.amount)),
    zero(detail.amount.currency),
  );
}

function Row({ label, value, onCopy }: { label: string; value: string; onCopy?: () => void }) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
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
          accessibilityLabel={t('common.copyItem', { item: label.toLowerCase() })}
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
 * repeat transfer when those make sense, plus the shareable receipt (ACC-7).
 */
export function TransactionDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  const { t: tr } = useTranslation();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const query = useRepoQuery('transactions', 'get', { path: { transaction_id: id } });
  const [picking, setPicking] = useState(false);
  const [similar, setSimilar] = useState(false);
  const [receipt, setReceipt] = useState(false);

  const recategorise = useRepoMutation('transactions', 'update', {
    invalidates: [['transactions'], ['insights']],
    onSuccess: (t, vars) => {
      haptic('success');
      setPicking(false);
      const label = CATEGORIES[t.category].label;
      const previous = query.data?.category;
      toast.show({
        message:
          previous === t.category
            ? tr('transactions.detail.thanks')
            : vars.body.apply_to_similar
              ? tr('transactions.detail.similarMoved', {
                  name: t.counterparty.name,
                  category: label,
                })
              : tr('transactions.detail.moved', { category: label }),
        tone: 'success',
      });
    },
    onError: (e) =>
      toast.show({
        message: e.problem.detail ?? tr('transactions.detail.categoryFailed'),
        tone: 'error',
      }),
  });

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    haptic('success');
    toast.show({ message: tr('common.copied', { label }), tone: 'success' });
  };

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <IconButton
        icon={ArrowLeft}
        accessibilityLabel={tr('common.back')}
        variant="ghost"
        onPress={() => router.back()}
      />
      <Text variant="title" accessibilityRole="header">
        {tr('transactions.detail.title')}
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
                ? tr('transactions.detail.notFound')
                : tr('transactions.detail.failed')
            }
            onRetry={() => void query.refetch()}
          />
        ) : (
          <SkeletonGroup accessibilityLabel={tr('transactions.detail.loading')}>
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
          {tr('transactions.detail.status')}
        </Text>
        <View style={{ marginTop: spacing[3] }}>
          <StatusTimeline steps={t.timeline} formatAt={formatDateTime} />
        </View>
      </Card>

      <Card>
        <Row label={tr('transactions.detail.type')} value={tr(`transactions.types.${t.type}`)} />
        {account !== '' && (
          <Row
            label={
              t.direction === 'debit'
                ? tr('transactions.detail.to')
                : tr('transactions.detail.from')
            }
            value={`${them.name}\n${account}`}
          />
        )}
        {them.nemtag && <Row label={tr('transactions.detail.nemtag')} value={`@${them.nemtag}`} />}
        {t.narration !== '' && (
          <Row label={tr('transactions.detail.narration')} value={t.narration} />
        )}
        <Row
          label={tr('transactions.detail.reference')}
          value={t.reference}
          onCopy={() => void copy(tr('transactions.detail.reference'), t.reference)}
        />
        {t.fees.map((f) => (
          <Row
            key={f.code}
            label={f.label}
            value={hidden ? '••••' : formatMoney(fromApiMoney(f.amount))}
          />
        ))}
        {t.fees.length > 1 && (
          <Row
            label={tr('transactions.detail.totalFees')}
            value={hidden ? '••••' : formatMoney(fees)}
          />
        )}
        {t.balance_after && (
          <Row
            label={tr('transactions.detail.balanceAfter')}
            value={hidden ? '••••' : formatMoney(fromApiMoney(t.balance_after))}
          />
        )}
      </Card>

      <Card>
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Text variant="label" color="textMuted" accessibilityRole="header" style={styles.flex}>
            {tr('transactions.detail.category')}
          </Text>
          {t.category_source === 'model' && (
            <AIBadge
              feature={tr('transactions.detail.smartFeature')}
              explanation={tr('transactions.detail.smartExplanation')}
              fallback={tr('transactions.detail.smartFallback')}
              onManage={() => router.push('/ai')}
            />
          )}
        </View>
        <ListItem
          leading={category.icon}
          title={category.label}
          subtitle={categorySourceText(t)}
          accessibilityLabel={tr('transactions.detail.categoryLabel', {
            category: category.label,
            source: categorySourceText(t),
          })}
          accessibilityHint={tr('transactions.detail.changeCategory')}
          showChevron
          onPress={() => setPicking(true)}
        />
        {isUnsure(t) && (
          <View style={{ gap: spacing[3] }}>
            <Text color="textMuted">
              {tr('transactions.detail.unsure', {
                name: them.name,
                category: category.label.toLowerCase(),
              })}
            </Text>
            <View style={[styles.row, { gap: spacing[3] }]}>
              <View style={styles.flex}>
                <Button
                  label={tr('transactions.detail.yesRight')}
                  variant="secondary"
                  loading={recategorise.isPending}
                  onPress={() =>
                    recategorise.mutate({
                      path: { transaction_id: t.id },
                      body: { category: t.category, apply_to_similar: true },
                    })
                  }
                />
              </View>
              <View style={styles.flex}>
                <Button
                  label={tr('transactions.detail.change')}
                  variant="ghost"
                  icon={Tag}
                  onPress={() => setPicking(true)}
                />
              </View>
            </View>
          </View>
        )}
      </Card>

      <View style={{ gap: spacing[3] }}>
        <Button
          label={tr('transactions.detail.shareReceipt')}
          icon={ReceiptText}
          variant="secondary"
          onPress={() => setReceipt(true)}
        />
        {t.status === 'pending' && t.transfer_id && (
          <Button
            label={tr('transactions.detail.whyPending')}
            icon={ShieldQuestion}
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/send/held/[id]', params: { id: t.transfer_id! } })
            }
          />
        )}
        {t.can_repeat && (
          <Button
            label={tr('transactions.detail.sendAgain')}
            icon={Repeat}
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/send', params: { repeat: t.transfer_id ?? t.id } })
            }
          />
        )}
        {t.dispute_id ? (
          <>
            <Text color="textMuted" style={styles.centerText}>
              {tr('transactions.detail.disputed')}
            </Text>
            <Button
              label={tr('transactions.detail.trackDispute')}
              icon={Flag}
              variant="ghost"
              onPress={() =>
                router.push({ pathname: '/disputes/[id]', params: { id: t.dispute_id! } })
              }
            />
          </>
        ) : (
          t.can_dispute && (
            <Button
              label={tr('transactions.detail.report')}
              icon={Flag}
              variant="ghost"
              onPress={() =>
                router.push({ pathname: '/disputes/new', params: { transaction: t.id } })
              }
            />
          )
        )}
        <Button
          label={tr('transactions.detail.askSupport')}
          icon={MessageCircle}
          variant="ghost"
          onPress={() => router.push({ pathname: '/support/new', params: { transaction: t.id } })}
        />
      </View>

      {receipt && <ReceiptSheet transactionId={t.id} onClose={() => setReceipt(false)} />}

      {picking && (
        <BottomSheet
          open
          onClose={() => setPicking(false)}
          title={tr('transactions.detail.choose')}
        >
          <View style={{ gap: spacing[3] }}>
            <Checkbox
              label={tr('transactions.detail.always', { name: them.name })}
              checked={similar}
              onChange={setSimilar}
            />
            <Text variant="caption" color="textMuted">
              {similar
                ? tr('transactions.detail.alwaysNote', { name: them.name })
                : tr('transactions.detail.onlyThis')}
            </Text>
            <View>
              {(Object.keys(CATEGORIES) as Category[]).map((c) => (
                <ListItem
                  key={c}
                  leading={CATEGORIES[c].icon}
                  title={CATEGORIES[c].label}
                  trailing={
                    c === t.category ? (
                      <Text color="primaryText">{tr('transactions.detail.current')}</Text>
                    ) : undefined
                  }
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
  label: { width: 112 },
  value: { flex: 1, textAlign: 'right' },
  flex: { flex: 1 },
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
  badge: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
});
