import { useRouter } from 'expo-router';
import { ArrowDownLeft, Ban, CreditCard, MonitorSmartphone, OctagonX } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Dialog,
  Divider,
  ErrorState,
  Icon,
  ListItem,
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
import { haptic } from '@/lib/haptics';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { panicSummary } from '../security';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('common.somethingWrong');

/**
 * Panic button (SEC-4). One confirmed tap freezes every card and blocks money
 * going out, with no PIN on purpose: it must work when someone is rushing you.
 * Turning it off needs PIN or Face ID.
 */
export function PanicScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const stepUp = useStepUp();
  const q = useRepoQuery('security', 'getPanic');
  const invalidates = [['security'], ['cards']];
  const activate = useRepoMutation('security', 'activatePanic', { invalidates });
  const release = useRepoMutation('security', 'releasePanic', { invalidates });
  const [asking, setAsking] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [stepUpError, setStepUpError] = useState<string>();
  const panic = q.data;

  const pressPanic = () =>
    activate.mutate(undefined, {
      onSuccess: (state) => {
        setAsking(false);
        haptic('warning');
        toast.show({ message: panicSummary(state), tone: 'success' });
      },
      onError: (e) => {
        setAsking(false);
        toast.show({ message: message(e), tone: 'error' });
      },
    });

  const releaseWith = async (proof: StepUpProof) => {
    try {
      const stepUpToken = await stepUp('unfreeze', 'panic', proof);
      await release.mutateAsync({ stepUpToken });
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      setStepUpError(e instanceof StepUpNeedsPin ? t('common.faceIdUsePin') : message(e));
      return false;
    }
    setReleasing(false);
    toast.show({ message: t('security.panic.off'), tone: 'success' });
    return true;
  };

  let body;
  if (q.isError && !panic) {
    body = <ErrorState title={t('security.panic.failed')} onRetry={() => q.refetch()} />;
  } else if (!panic) {
    body = (
      <SkeletonGroup accessibilityLabel={t('security.panic.loading')}>
        <Skeleton height={200} />
      </SkeletonGroup>
    );
  } else if (panic.active) {
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[3] }} accessibilityRole="alert">
            <View style={[styles.row, { gap: spacing[2] }]}>
              <Icon
                icon={OctagonX}
                color="danger"
                accessibilityLabel={t('security.panic.onLabel')}
              />
              <Text variant="h3">{t('security.panic.isOn')}</Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {panic.activated_at
                ? t('security.panic.since', {
                    when: formatDateTime(panic.activated_at),
                    summary: panicSummary(panic),
                  })
                : panicSummary(panic)}
            </Text>
            <Text variant="bodySmall" color="textMuted">
              {t('security.panic.stillIn')}
            </Text>
            <Button
              label={t('security.panic.turnOff')}
              variant="secondary"
              onPress={() => {
                setStepUpError(undefined);
                setReleasing(true);
              }}
            />
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('security.panic.whileSafe')} />
          <Card padded={false}>
            <ListItem
              title={t('security.panic.reviewDevices')}
              subtitle={t('security.panic.reviewDevicesHelp')}
              leading={MonitorSmartphone}
              onPress={() => router.push('/security/devices')}
            />
          </Card>
        </View>
      </>
    );
  } else {
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[4] }}>
            <Text variant="bodySmall" color="textMuted">
              {t('security.panic.intro')}
            </Text>
            <Button
              label={t('security.panic.freeze')}
              variant="danger"
              size="lg"
              onPress={() => setAsking(true)}
              accessibilityHint={t('security.panic.freezeHint')}
            />
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('security.panic.whatHappens')} />
          <Card padded={false}>
            <ListItem
              title={t('security.panic.cards')}
              subtitle={t('security.panic.cardsHelp')}
              leading={CreditCard}
            />
            <Divider />
            <ListItem
              title={t('security.panic.noLeave')}
              subtitle={t('security.panic.noLeaveHelp')}
              leading={Ban}
            />
            <Divider />
            <ListItem
              title={t('security.panic.comeIn')}
              subtitle={t('security.panic.comeInHelp')}
              leading={ArrowDownLeft}
            />
          </Card>
          <Text variant="bodySmall" color="textMuted">
            {t('security.panic.needsPin')}
          </Text>
        </View>
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('security.panic.title')} />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {body}
      <Dialog
        open={asking}
        title={t('security.panic.confirmTitle')}
        message={t('security.panic.confirmMessage')}
        confirmLabel={t('security.panic.freeze')}
        destructive
        loading={activate.isPending}
        onConfirm={pressPanic}
        onCancel={() => setAsking(false)}
      />
      <ConfirmSheet
        open={releasing}
        onClose={() => setReleasing(false)}
        subtitle={t('security.panic.turnOff')}
        error={stepUpError}
        onApproved={(pin) => (pin ? releaseWith({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => releaseWith({ biometric: label })}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
