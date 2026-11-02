import { Ban, EyeOff, KeyRound, Siren, UserX, Wallet } from 'lucide-react-native';
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
  PinPad,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
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
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('common.somethingWrong');

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
  const { t } = useTranslation();
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
      onError(t('security.duress.mismatch'));
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
          title={t('security.duress.choose')}
          subtitle={t('security.duress.chooseHelp')}
          error={error}
          onComplete={choose}
        />
      ) : (
        <PinPad
          key="confirm"
          title={t('security.duress.again')}
          subtitle={t('security.duress.againHelp')}
          error={error}
          onComplete={confirm}
        />
      )}
      <Button label={t('common.cancel')} variant="ghost" onPress={onCancel} />
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
  const { t } = useTranslation();
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
      setStepUpError(e instanceof StepUpNeedsPin ? t('common.faceIdUsePin') : message(e));
      return false;
    }
    const done = t(pending.action === 'set' ? 'security.duress.set' : 'security.duress.removed');
    setPending(null);
    toast.show({ message: done, tone: 'success' });
    return true;
  };

  const confirmSheet = (
    <ConfirmSheet
      open={pending !== null}
      onClose={() => setPending(null)}
      subtitle={t(
        pending?.action === 'remove' ? 'security.duress.removeStep' : 'security.duress.saveStep',
      )}
      error={stepUpError}
      onApproved={(pin) => (pin ? approve({ pin }) : Promise.resolve(false))}
      approveWithBiometrics={(label) => approve({ biometric: label })}
    />
  );

  if (entering) {
    return (
      <Screen
        header={<SendHeader title={t('security.duress.title')} />}
        scroll={false}
        edges={['top', 'bottom']}
      >
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
    status = <ErrorState title={t('security.duress.failed')} onRetry={() => q.refetch()} />;
  } else if (isSet === undefined) {
    status = (
      <SkeletonGroup accessibilityLabel={t('security.duress.loading')}>
        <Skeleton height={140} />
      </SkeletonGroup>
    );
  } else if (isSet) {
    status = (
      <Card>
        <View style={{ gap: spacing[3] }}>
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Icon icon={KeyRound} color="success" accessibilityLabel={t('security.duress.on')} />
            <Text variant="h3">{t('security.duress.isOn')}</Text>
          </View>
          <Text variant="bodySmall" color="textMuted">
            {t('security.duress.secret')}
          </Text>
          <View style={[styles.row, { gap: spacing[2] }]}>
            <View style={styles.flex}>
              <Button label={t('common.change')} variant="secondary" onPress={startEntry} />
            </View>
            <View style={styles.flex}>
              <Button label={t('common.remove')} variant="ghost" onPress={() => setAsking(true)} />
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
            {t('security.duress.intro')}
          </Text>
          <Button label={t('security.duress.setButton')} size="lg" onPress={startEntry} />
        </View>
      </Card>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('security.duress.title')} />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {status}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('security.duress.whatHappens')} />
        <Card padded={false}>
          <ListItem
            title={t('security.duress.opens')}
            subtitle={t('security.duress.opensHelp')}
            leading={EyeOff}
          />
          <Divider />
          <ListItem
            title={t('security.duress.small')}
            subtitle={t('security.duress.smallHelp')}
            leading={Wallet}
          />
          <Divider />
          <ListItem
            title={t('security.duress.fake')}
            subtitle={t('security.duress.fakeHelp')}
            leading={Ban}
          />
          <Divider />
          <ListItem
            title={t('security.duress.alerted')}
            subtitle={t('security.duress.alertedHelp')}
            leading={Siren}
          />
          <Divider />
          <ListItem
            title={t('security.duress.ends')}
            subtitle={t('security.duress.endsHelp')}
            leading={UserX}
          />
        </Card>
      </View>
      <Dialog
        open={asking}
        title={t('security.duress.removeTitle')}
        message={t('security.duress.removeMessage')}
        confirmLabel={t('common.remove')}
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
