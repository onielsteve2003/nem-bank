import { useRouter } from 'expo-router';
import { ArrowDownLeft, Ban, CreditCard, MonitorSmartphone, OctagonX } from 'lucide-react-native';
import { useState } from 'react';
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
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'Something went wrong. Try again.';

/**
 * Panic button (SEC-4). One confirmed tap freezes every card and blocks money
 * going out, with no PIN on purpose: it must work when someone is rushing you.
 * Turning it off needs PIN or Face ID.
 */
export function PanicScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
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
      setStepUpError(
        e instanceof StepUpNeedsPin
          ? 'Face ID isn’t set up for this here. Enter your PIN.'
          : message(e),
      );
      return false;
    }
    setReleasing(false);
    toast.show({ message: 'Panic mode is off', tone: 'success' });
    return true;
  };

  let body;
  if (q.isError && !panic) {
    body = <ErrorState title="We couldn't check panic mode" onRetry={() => q.refetch()} />;
  } else if (!panic) {
    body = (
      <SkeletonGroup accessibilityLabel="Checking panic mode">
        <Skeleton height={200} />
      </SkeletonGroup>
    );
  } else if (panic.active) {
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[3] }} accessibilityRole="alert">
            <View style={[styles.row, { gap: spacing[2] }]}>
              <Icon icon={OctagonX} color="danger" accessibilityLabel="Panic mode on" />
              <Text variant="h3">Panic mode is on</Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {panic.activated_at
                ? `Since ${formatDateTime(panic.activated_at)}. ${panicSummary(panic)}`
                : panicSummary(panic)}
            </Text>
            <Text variant="bodySmall" color="textMuted">
              Money can still come in. Turning panic mode off unfreezes the cards it froze and lets
              money go out again.
            </Text>
            <Button
              label="Turn off panic mode"
              variant="secondary"
              onPress={() => {
                setStepUpError(undefined);
                setReleasing(true);
              }}
            />
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="While you’re safe" />
          <Card padded={false}>
            <ListItem
              title="Review your devices"
              subtitle="Remove any you don’t recognise"
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
              Lost your phone, card or think someone is in your account? One tap stops everything.
            </Text>
            <Button
              label="Freeze everything"
              variant="danger"
              size="lg"
              onPress={() => setAsking(true)}
              accessibilityHint="Freezes every card and blocks money going out"
            />
          </View>
        </Card>
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="What happens" />
          <Card padded={false}>
            <ListItem
              title="Every card is frozen"
              subtitle="No card payments"
              leading={CreditCard}
            />
            <Divider />
            <ListItem
              title="No money can leave"
              subtitle="Transfers, bills and conversions stop"
              leading={Ban}
            />
            <Divider />
            <ListItem
              title="Money can still come in"
              subtitle="Salary and transfers to you still arrive"
              leading={ArrowDownLeft}
            />
          </Card>
          <Text variant="bodySmall" color="textMuted">
            Turning it off needs your PIN or Face ID.
          </Text>
        </View>
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Panic button" />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {body}
      <Dialog
        open={asking}
        title="Freeze everything?"
        message="Every card is frozen and no money can leave your account until you turn this off with your PIN."
        confirmLabel="Freeze everything"
        destructive
        loading={activate.isPending}
        onConfirm={pressPanic}
        onCancel={() => setAsking(false)}
      />
      <ConfirmSheet
        open={releasing}
        onClose={() => setReleasing(false)}
        subtitle="Turn off panic mode"
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
