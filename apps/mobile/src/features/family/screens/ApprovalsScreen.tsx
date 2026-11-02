import type { Schema } from '@nem/contracts';
import { ListChecks } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import {
  StepUpCancelled,
  StepUpNeedsPin,
  useStepUp,
  type StepUpProof,
} from '@/features/cards/hooks/useStepUp';
import { formatDateTime } from '@/features/transactions/format';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { APPROVAL_STATUS, nairaText } from '../family';

type Approval = Schema<'FamilyApproval'>;

const message = (e: unknown) =>
  isApiError(e) ? (e.problem.detail ?? e.problem.title) : i18n.t('common.somethingWrong');

/**
 * The parent's approvals queue (FAM-2): a child's transfer above their
 * threshold waits here. Approving needs your PIN or Face ID; it expires in 24h.
 */
export function ApprovalsScreen() {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const stepUp = useStepUp();
  const q = useRepoQuery('family', 'listApprovals', {});
  const approve = useMoneyMutation('family', 'approve', { invalidates: [['family']] });
  const decline = useRepoMutation('family', 'decline', {
    onSuccess: (a) =>
      toast.show({ message: t('family.approvals.declined', { name: a.dependant.name }) }),
    onError: (e) => toast.show({ message: message(e), tone: 'error' }),
  });
  const [confirming, setConfirming] = useState<Approval>();
  const [error, setError] = useState<string>();

  const header = <SendHeader title={t('family.approvals.title')} />;
  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title={t('family.approvals.failed')} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('family.approvals.loading')}>
            <Skeleton height={140} />
            <Skeleton height={140} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const confirm = async (proof: StepUpProof) => {
    if (!confirming) return false;
    setError(undefined);
    try {
      await stepUp('transfer', confirming.id, proof);
      const a = await approve.mutateAsync({ path: { approval_id: confirming.id } });
      toast.show({
        message: t('family.approvals.sent', {
          amount: nairaText(a.amount),
          name: a.dependant.name,
        }),
        tone: 'success',
      });
      setConfirming(undefined);
      return true;
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      setError(e instanceof StepUpNeedsPin ? t('common.faceIdUsePin') : message(e));
      return false;
    }
  };

  const pending = q.data.data.filter((a) => a.status === 'pending');
  const past = q.data.data.filter((a) => a.status !== 'pending');

  const card = (a: Approval) => {
    const status = APPROVAL_STATUS[a.status];
    return (
      <Card key={a.id}>
        <View style={{ gap: spacing[3] }}>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <Avatar name={a.dependant.name} size="md" />
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="bodyStrong">{`${a.dependant.name} → ${a.recipient.name}`}</Text>
              <Text variant="bodySmall" color="textMuted">
                {`“${a.narration}” · ${formatDateTime(a.created_at)}`}
              </Text>
            </View>
            <MoneyText value={fromApiMoney(a.amount)} variant="bodyStrong" trimZeroMinor />
          </View>
          {a.status === 'pending' ? (
            <>
              <Text variant="caption" color="textMuted">
                {t('family.approvals.expires', { when: formatDateTime(a.expires_at) })}
              </Text>
              <View style={[styles.row, { gap: spacing[2] }]}>
                <View style={styles.flex}>
                  <Button
                    label={t('common.decline')}
                    variant="secondary"
                    fullWidth
                    loading={decline.isPending && decline.variables?.path.approval_id === a.id}
                    onPress={() => decline.mutate({ path: { approval_id: a.id } })}
                  />
                </View>
                <View style={styles.flex}>
                  <Button
                    label={t('common.approve')}
                    fullWidth
                    onPress={() => {
                      setError(undefined);
                      setConfirming(a);
                    }}
                  />
                </View>
              </View>
            </>
          ) : (
            <Badge label={status.label} tone={status.tone} />
          )}
        </View>
      </Card>
    );
  };

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {pending.length ? (
        pending.map(card)
      ) : (
        <EmptyState
          icon={ListChecks}
          title={t('family.approvals.emptyTitle')}
          message={t('family.approvals.emptyMessage')}
        />
      )}
      {past.length > 0 && (
        <>
          <SectionHeader title={t('family.approvals.earlier')} />
          {past.map(card)}
        </>
      )}
      <ConfirmSheet
        open={Boolean(confirming)}
        onClose={() => setConfirming(undefined)}
        subtitle={
          confirming
            ? t('family.approvals.confirm', {
                child: confirming.dependant.name,
                amount: nairaText(confirming.amount),
                recipient: confirming.recipient.name,
              })
            : ''
        }
        error={error}
        onApproved={(pin) => (pin ? confirm({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => confirm({ biometric: label })}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
