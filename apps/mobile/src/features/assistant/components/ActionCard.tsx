import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import {
  ArrowLeftRight,
  CircleCheck,
  CircleSlash,
  Lock,
  PiggyBank,
  Receipt,
  Send,
  Snowflake,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, MoneyText, Text } from '@/components';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoMutation } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import {
  STATUS_LINE,
  actionStatus,
  expiresIn,
  isStaleAction,
  resultRoute,
  type PreparedAction,
} from '../assistant';

const KIND_ICON: Record<PreparedAction['kind'], LucideIcon> = {
  transfer: Send,
  bill_payment: Receipt,
  savings_deposit: PiggyBank,
  card_freeze: Snowflake,
  fx_conversion: ArrowLeftRight,
};

// Confirming can touch any of these, whatever the action was.
const INVALIDATES = [
  ['assistant'],
  ['accounts'],
  ['transactions'],
  ['transfers'],
  ['cards'],
  ['bills'],
  ['savings'],
  ['fx'],
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <Text variant="bodySmall" color="textMuted">
        {label}
      </Text>
      {children}
    </View>
  );
}

type Props = { action: PreparedAction };

/**
 * A money action the assistant prepared (AI-6). Nothing happens until the
 * customer checks it and confirms with their PIN or Face ID; the bank then runs
 * it through the same limits, fees and risk checks as the normal screens.
 */
export function ActionCard({ action: initial }: Props) {
  const router = useRouter();
  const client = useQueryClient();
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  // What the bank answered when this card confirmed or cancelled it; until then, the chat's copy.
  const [answered, setAction] = useState<PreparedAction | null>(null);
  const action = answered ?? initial;
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = useMoneyMutation('assistant', 'confirmAction', { invalidates: INVALIDATES });
  const discard = useRepoMutation('assistant', 'discardAction', { invalidates: [['assistant']] });

  const status = actionStatus(action);
  const amount = 'amount' in action.details ? fromApiMoney(action.details.amount) : null;
  const fee = action.quote ? fromApiMoney(action.quote.fee) : null;
  const total = action.quote ? fromApiMoney(action.quote.total_debit) : null;

  const onApproved = async () => {
    setError(undefined);
    try {
      const done = await confirm.mutateAsync({ path: { action_id: action.id } });
      setAction(done);
      setConfirming(false);
      haptic('success');
      // A transfer can still be held or need a check: its result screen explains which.
      if (done.result?.resource === 'transfer') router.push(resultRoute(done.result));
      return true;
    } catch (e) {
      if (isStaleAction(e)) {
        setConfirming(false);
        await client.invalidateQueries({ queryKey: ['assistant'] });
        return false;
      }
      setError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  const onDiscard = () =>
    discard.mutate({ path: { action_id: action.id } }, { onSuccess: setAction });

  return (
    <View
      style={[
        styles.box,
        {
          borderColor: status === 'prepared' ? colors.primaryText : colors.border,
          borderRadius: radius.md,
          padding: spacing[3],
          gap: spacing[2],
        },
      ]}
      accessibilityLabel={t('assistant.action.prepared', { summary: action.summary })}
    >
      <View style={[styles.head, { gap: spacing[2] }]}>
        <Icon icon={KIND_ICON[action.kind]} color="primaryText" />
        <Text variant="bodyStrong" style={styles.flex}>
          {action.summary}
        </Text>
      </View>
      {amount && (
        <Row label={t('common.amount')}>
          <MoneyText value={amount} variant="bodyStrong" masked={hidden} />
        </Row>
      )}
      {fee && (
        <Row label={t('common.fee')}>
          <MoneyText value={fee} variant="bodyStrong" masked={hidden} />
        </Row>
      )}
      {total && (
        <Row label={t('assistant.action.total')}>
          <MoneyText value={total} variant="bodyStrong" masked={hidden} />
        </Row>
      )}

      {status === 'prepared' ? (
        <>
          <Text variant="caption" color="textMuted">
            {t('assistant.action.nothingMoves', { expires: expiresIn(action) })}
          </Text>
          {error && !confirming && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          <View style={[styles.head, { gap: spacing[2] }]}>
            <Button
              label={t('common.confirm')}
              icon={Lock}
              size="sm"
              style={styles.flex}
              accessibilityHint={t('assistant.action.confirmHint')}
              loading={confirm.isPending}
              onPress={() => setConfirming(true)}
            />
            <Button
              label={t('common.cancel')}
              variant="secondary"
              size="sm"
              style={styles.flex}
              loading={discard.isPending}
              disabled={confirm.isPending}
              onPress={onDiscard}
            />
          </View>
        </>
      ) : (
        <View style={[styles.head, { gap: spacing[2] }]} accessibilityLiveRegion="polite">
          <Icon
            icon={status === 'confirmed' ? CircleCheck : CircleSlash}
            color={status === 'confirmed' ? 'success' : 'textMuted'}
            size="sm"
          />
          <Text variant="bodySmall" style={styles.flex}>
            {STATUS_LINE[status]}
          </Text>
          {status === 'confirmed' && action.result && (
            <Button
              label={t('common.view')}
              variant="ghost"
              size="sm"
              onPress={() => router.push(resultRoute(action.result!))}
            />
          )}
        </View>
      )}

      {confirming && (
        <ConfirmSheet
          open
          onClose={() => setConfirming(false)}
          subtitle={action.summary}
          onApproved={onApproved}
          error={error}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1 },
  head: { flexDirection: 'row', alignItems: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  flex: { flex: 1 },
});
