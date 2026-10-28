import { Ban, EyeOff, KeyRound, Siren, UserX, Wallet } from 'lucide-react-native';
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
  PinPad,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { weakPinMessage } from '@/features/auth/screens/CreatePinScreen';
import {
  StepUpCancelled,
  StepUpNeedsPin,
  useStepUp,
  type StepUpProof,
} from '@/features/cards/hooks/useStepUp';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useSecureScreen } from '@/lib/screenCapture';
import { useTheme } from '@/theme';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'Something went wrong. Try again.';

/** The bank refused the PIN itself (weak, or the same as the real PIN): choose again. */
const isPinRefused = (e: unknown) =>
  isApiError(e) && (e.problem.code === 'weak_pin' || e.problem.code === 'validation_failed');

type Pending = { action: 'set'; pin: string } | { action: 'remove' };

/** Entering a new duress PIN: choose, then the same again. */
function DuressPinEntry({
  error,
  onError,
  onChosen,
  onCancel,
}: {
  error?: string;
  onError: (error: string | undefined) => void;
  onChosen: (pin: string) => void;
  onCancel: () => void;
}) {
  const [first, setFirst] = useState<string | null>(null);
  useSecureScreen();

  const choose = async (pin: string) => {
    const weak = weakPinMessage(pin);
    onError(weak);
    if (weak) return false;
    setFirst(pin);
    return true;
  };

  const confirm = async (pin: string) => {
    if (pin !== first) {
      setFirst(null);
      onError("The PINs didn't match. Choose your duress PIN again.");
      return false;
    }
    onError(undefined);
    onChosen(pin);
    return true;
  };

  return (
    <View style={styles.pad}>
      {first === null ? (
        <PinPad
          key="choose"
          title="Choose a duress PIN"
          subtitle="4 digits, different from your real PIN"
          error={error}
          onComplete={choose}
        />
      ) : (
        <PinPad
          key="confirm"
          title="Enter it again"
          subtitle="The same 4 digits"
          error={error}
          onComplete={confirm}
        />
      )}
      <Button label="Cancel" variant="ghost" onPress={onCancel} />
    </View>
  );
}

/**
 * Duress PIN (SEC-5). If someone forces you to open the app or approve a
 * payment, entering this PIN instead of your own shows a decoy low balance,
 * lets payments look sent while no money moves, and quietly alerts the bank.
 * The app never knows which PIN was used; the bank decides what to show.
 */
export function DuressScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
  const stepUp = useStepUp();
  const q = useRepoQuery('security', 'getCheckup');
  const invalidates = [['security']];
  const save = useRepoMutation('security', 'setDuressPin', { invalidates });
  const remove = useRepoMutation('security', 'removeDuressPin', { invalidates });
  const [entering, setEntering] = useState(false);
  const [entryError, setEntryError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [stepUpError, setStepUpError] = useState<string>();
  const isSet = q.data?.items.find((i) => i.id === 'duress_pin_set')?.done;

  const approve = async (proof: StepUpProof) => {
    if (!pending) return false;
    try {
      const stepUpToken = await stepUp('pin_reset', 'duress_pin', proof);
      if (pending.action === 'set')
        await save.mutateAsync({ body: { pin: pending.pin }, stepUpToken });
      else await remove.mutateAsync({ stepUpToken });
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      if (pending.action === 'set' && isPinRefused(e)) {
        // Back to the pad: the PIN itself was the problem, not the approval.
        setPending(null);
        setEntryError(message(e));
        setEntering(true);
        return true;
      }
      setStepUpError(
        e instanceof StepUpNeedsPin
          ? 'Face ID isn’t set up for this here. Enter your PIN.'
          : message(e),
      );
      return false;
    }
    const done = pending.action === 'set' ? 'Your duress PIN is set' : 'Your duress PIN is removed';
    setPending(null);
    toast.show({ message: done, tone: 'success' });
    return true;
  };

  const confirmSheet = (
    <ConfirmSheet
      open={pending !== null}
      onClose={() => setPending(null)}
      subtitle={pending?.action === 'remove' ? 'Remove your duress PIN' : 'Save your duress PIN'}
      error={stepUpError}
      onApproved={(pin) => (pin ? approve({ pin }) : Promise.resolve(false))}
      approveWithBiometrics={(label) => approve({ biometric: label })}
    />
  );

  if (entering) {
    return (
      <Screen header={<SendHeader title="Duress PIN" />} scroll={false} edges={['top', 'bottom']}>
        <DuressPinEntry
          error={entryError}
          onError={setEntryError}
          onCancel={() => {
            setEntryError(undefined);
            setEntering(false);
          }}
          onChosen={(pin) => {
            setEntering(false);
            setStepUpError(undefined);
            setPending({ action: 'set', pin });
          }}
        />
        {confirmSheet}
      </Screen>
    );
  }

  const startEntry = () => {
    setEntryError(undefined);
    setEntering(true);
  };

  let status;
  if (q.isError && !q.data) {
    status = <ErrorState title="We couldn't check your duress PIN" onRetry={() => q.refetch()} />;
  } else if (isSet === undefined) {
    status = (
      <SkeletonGroup accessibilityLabel="Checking your duress PIN">
        <Skeleton height={140} />
      </SkeletonGroup>
    );
  } else if (isSet) {
    status = (
      <Card>
        <View style={{ gap: spacing[3] }}>
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Icon icon={KeyRound} color="success" accessibilityLabel="On" />
            <Text variant="h3">Your duress PIN is on</Text>
          </View>
          <Text variant="bodySmall" color="textMuted">
            Only you know it. Don’t write it down next to your real PIN.
          </Text>
          <View style={[styles.row, { gap: spacing[2] }]}>
            <View style={styles.flex}>
              <Button label="Change" variant="secondary" onPress={startEntry} />
            </View>
            <View style={styles.flex}>
              <Button label="Remove" variant="ghost" onPress={() => setAsking(true)} />
            </View>
          </View>
        </View>
      </Card>
    );
  } else {
    status = (
      <Card>
        <View style={{ gap: spacing[4] }}>
          <Text variant="bodySmall" color="textMuted">
            If someone ever forces you to open Nem Bank or approve a payment, enter this PIN instead
            of your real one.
          </Text>
          <Button label="Set a duress PIN" size="lg" onPress={startEntry} />
        </View>
      </Card>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Duress PIN" />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {status}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="What happens when it’s used" />
        <Card padded={false}>
          <ListItem
            title="The app opens as normal"
            subtitle="Nothing on screen gives it away"
            leading={EyeOff}
          />
          <Divider />
          <ListItem
            title="They see a small balance"
            subtitle="Your real balances and bigger payments stay hidden"
            leading={Wallet}
          />
          <Divider />
          <ListItem
            title="Payments look sent, but no money moves"
            subtitle="They show as on their way"
            leading={Ban}
          />
          <Divider />
          <ListItem
            title="We’re alerted quietly"
            subtitle="Our security team sees it straight away"
            leading={Siren}
          />
          <Divider />
          <ListItem
            title="Your real PIN ends it"
            subtitle="Unlock with it later and everything is back; those payments show as stopped"
            leading={UserX}
          />
        </Card>
      </View>
      <Dialog
        open={asking}
        title="Remove your duress PIN?"
        message="You can set a new one at any time. You'll confirm with your PIN or Face ID."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          setAsking(false);
          setStepUpError(undefined);
          setPending({ action: 'remove' });
        }}
        onCancel={() => setAsking(false)}
      />
      {confirmSheet}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
