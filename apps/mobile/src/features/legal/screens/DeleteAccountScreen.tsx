import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { CircleCheck, Dot } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Icon,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { isApiError } from '@/data';
import {
  StepUpCancelled,
  StepUpNeedsPin,
  useStepUp,
  type StepUpProof,
} from '@/features/cards/hooks/useStepUp';
import { formatDate } from '@/features/transactions/format';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import i18n from '@/lib/i18n';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

const message = (e: unknown) =>
  isApiError(e) ? (e.problem.detail ?? e.problem.title) : i18n.t('common.somethingWrong');

/**
 * Request account deletion (SET-5, NDPA 2023). Every balance must be zero
 * first, and the request needs a fresh PIN or Face ID step-up. Profile data is
 * erased; ledger records are kept for the AML retention period.
 */
export function DeleteAccountScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const stepUp = useStepUp();
  const accounts = useRepoQuery('accounts', 'list');
  const deletion = useRepoMutation('privacy', 'requestDeletion', { invalidates: [] });
  const [understood, setUnderstood] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState<Schema<'PrivacyRequest'>>();

  const header = <SendHeader title={t('yourData.delete.title')} />;

  if (request) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={CircleCheck}
          title={t('yourData.delete.received')}
          message={t('yourData.delete.receivedBody', { date: formatDate(request.completes_by) })}
          actionLabel={t('common.done')}
          onAction={() => router.dismissTo('/me')}
        />
      </Screen>
    );
  }

  const confirm = async (proof: StepUpProof) => {
    setError(undefined);
    try {
      const stepUpToken = await stepUp('account_deletion', 'account', proof);
      setRequest(await deletion.mutateAsync({ stepUpToken }));
      setConfirming(false);
      return true;
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      setError(e instanceof StepUpNeedsPin ? t('common.faceIdUsePin') : message(e));
      return false;
    }
  };

  const funded = accounts.data?.data.filter((a) => a.ledger_balance.amount_minor !== '0') ?? [];
  const steps: string[] = t('yourData.delete.steps', { returnObjects: true });

  return (
    <Screen header={header} edges={['top', 'bottom']}>
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('yourData.delete.what')} />
        <Card>
          <View style={{ gap: spacing[2] }}>
            {steps.map((step) => (
              <View key={step} style={[styles.row, { gap: spacing[1] }]}>
                <Icon icon={Dot} color="textMuted" />
                <Text variant="bodySmall" style={styles.flex}>
                  {step}
                </Text>
              </View>
            ))}
          </View>
        </Card>
      </View>

      {!accounts.data ? (
        accounts.isError ? (
          <ErrorState title={t('yourData.delete.failed')} onRetry={() => void accounts.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('yourData.delete.loading')}>
            <Skeleton height={96} />
          </SkeletonGroup>
        )
      ) : funded.length ? (
        <Card variant="outline">
          <View style={{ gap: spacing[3] }}>
            <Text variant="bodyStrong" accessibilityRole="header">
              {t('yourData.delete.balancesTitle')}
            </Text>
            <Text variant="bodySmall" color="textMuted">
              {t('yourData.delete.balancesBody')}
            </Text>
            {funded.map((a) => (
              <View key={a.id} style={[styles.row, styles.center]}>
                <Text variant="bodySmall" style={styles.flex}>
                  {t('common.walletName', { name: a.currency })}
                </Text>
                <MoneyText value={fromApiMoney(a.ledger_balance)} variant="bodyStrong" />
              </View>
            ))}
            <Button
              label={t('yourData.delete.sendMoney')}
              variant="secondary"
              fullWidth
              onPress={() => router.push('/send')}
            />
          </View>
        </Card>
      ) : (
        <View style={[styles.row, styles.center, { gap: spacing[2] }]}>
          <Icon icon={CircleCheck} color="success" />
          <Text variant="bodySmall">{t('yourData.delete.allClear')}</Text>
        </View>
      )}

      <Checkbox
        label={t('yourData.delete.understand')}
        checked={understood}
        onChange={setUnderstood}
        disabled={!accounts.data || funded.length > 0}
      />
      <Button
        label={t('yourData.delete.button')}
        variant="danger"
        fullWidth
        disabled={!accounts.data || funded.length > 0 || !understood}
        onPress={() => {
          setError(undefined);
          setConfirming(true);
        }}
      />

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={t('yourData.delete.confirm')}
        error={error}
        onApproved={(pin) => (pin ? confirm({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => confirm({ biometric: label })}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  center: { alignItems: 'center' },
  flex: { flex: 1 },
});
