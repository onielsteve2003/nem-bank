import type { Schema } from '@nem/contracts';
import { KeyRound } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, OtpInput, PinPad, Text } from '@/components';
import { isApiError } from '@/data';
import { DEMO_OTP } from '@/data/mock';
import { env } from '@/lib/env';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { formatCountdown, otpErrorMessage, useSecondsUntil } from '../otp';
import { weakPinMessage } from '../screens/CreatePinScreen';

type Stage =
  | { kind: 'intro' }
  | { kind: 'code'; stepUp: Schema<'StepUpChallenge'> }
  | { kind: 'choose'; token: string }
  | { kind: 'confirm'; token: string; pin: string };

/**
 * Reset the transaction PIN with step-up (AUTH-9): an emailed code proves it is
 * the account owner, and the bank's short-lived step-up token authorises the
 * new PIN. Clears any PIN lockout. Used from the lock screen ("Forgot PIN?").
 */
export function ResetPinFlow({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { spacing } = useTheme();
  const [stage, setStage] = useState<Stage>({ kind: 'intro' });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [attemptsLeft, setAttemptsLeft] = useState(0);
  const otp = stage.kind === 'code' ? stage.stepUp.otp : null;
  const resendIn = useSecondsUntil(otp?.resend_available_at ?? '');

  const start = useRepoMutation('auth', 'startStepUp', { invalidates: [] });
  const resend = useRepoMutation('auth', 'resendOtp', { invalidates: [] });
  const verify = useRepoMutation('auth', 'verifyStepUp', { invalidates: [] });
  const reset = useRepoMutation('users', 'resetPin', { invalidates: [] });

  const sendCode = () => {
    setError(undefined);
    start.mutate(
      { body: { purpose: 'pin_reset' } },
      {
        onSuccess: (stepUp) => {
          setStage({ kind: 'code', stepUp });
          setAttemptsLeft(stepUp.otp?.attempts_remaining ?? 0);
          setCode('');
        },
        onError: (e) =>
          setError(
            isApiError(e) && e.problem.code === 'offline'
              ? "You're offline. Reconnect and try again."
              : "We couldn't send a code. Try again.",
          ),
      },
    );
  };

  const checkCode = (entered: string) => {
    if (stage.kind !== 'code' || verify.isPending || attemptsLeft <= 0) return;
    verify.mutate(
      { path: { step_up_id: stage.stepUp.step_up_id }, body: { otp_code: entered } },
      {
        onSuccess: (result) => {
          setError(undefined);
          setStage({ kind: 'choose', token: result.step_up_token });
        },
        onError: (e) => {
          const problemCode = isApiError(e) ? e.problem.code : '';
          const left = problemCode === 'invalid_otp' ? attemptsLeft - 1 : attemptsLeft;
          setAttemptsLeft(left);
          setError(otpErrorMessage(e, left));
          setCode('');
        },
      },
    );
  };

  const sendAgain = () => {
    if (stage.kind !== 'code' || !stage.stepUp.otp) return;
    resend.mutate(
      { body: { challenge_id: stage.stepUp.otp.challenge_id } },
      {
        onSuccess: (fresh) => {
          setStage({ kind: 'code', stepUp: { ...stage.stepUp, otp: fresh } });
          setAttemptsLeft(fresh.attempts_remaining);
          setError(undefined);
          setCode('');
        },
        onError: () => setError("We couldn't send a new code. Try again."),
      },
    );
  };

  if (stage.kind === 'choose' || stage.kind === 'confirm') {
    const choose = async (pin: string) => {
      const weak = weakPinMessage(pin);
      setError(weak);
      if (weak || stage.kind !== 'choose') return false;
      setStage({ kind: 'confirm', token: stage.token, pin });
      return true;
    };
    const confirm = async (pin: string) => {
      if (stage.kind !== 'confirm') return false;
      if (pin !== stage.pin) {
        setStage({ kind: 'choose', token: stage.token });
        setError("The PINs didn't match. Choose your new PIN again.");
        return false;
      }
      try {
        await reset.mutateAsync({ body: { pin }, stepUpToken: stage.token });
        setError(undefined);
        onDone();
        return true;
      } catch (e) {
        const problem = isApiError(e) ? e.problem : null;
        if (problem?.code === 'weak_pin' || problem?.code === 'validation_failed') {
          setStage({ kind: 'choose', token: stage.token });
          setError(`${problem.title}. Choose another PIN.`);
        } else if (problem?.code === 'step_up_required' || problem?.code === 'forbidden') {
          setStage({ kind: 'intro' });
          setError('That took too long. Ask for a new code.');
        } else {
          setError("We couldn't save your PIN. Try again.");
        }
        return false;
      }
    };
    return (
      <View style={styles.pad}>
        {stage.kind === 'choose' ? (
          <PinPad
            key="choose"
            title="Choose a new PIN"
            subtitle="4 digits to approve payments and unlock the app"
            error={error}
            onComplete={choose}
          />
        ) : (
          <PinPad
            key="confirm"
            title="Confirm your new PIN"
            subtitle="Enter the same 4 digits again"
            error={error}
            onComplete={confirm}
          />
        )}
        <Button
          label="Cancel"
          variant="ghost"
          size="sm"
          onPress={onCancel}
          style={{ alignSelf: 'center', marginTop: spacing[4] }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.pad, { padding: spacing[4], gap: spacing[6] }]}>
      <View style={{ gap: spacing[2] }}>
        <Icon icon={KeyRound} size="xl" color="primaryText" />
        <Text variant="h1">Reset your PIN</Text>
        <Text color="textMuted">
          {otp
            ? `Enter the 6-digit code we sent to ${otp.destination_masked}.`
            : 'To keep your money safe, we will email you a code to confirm it is you. Then you can choose a new PIN.'}
        </Text>
      </View>

      {otp && (
        <OtpInput
          value={code}
          onChangeText={(next) => {
            setCode(next);
            if (error && attemptsLeft > 0) setError(undefined);
          }}
          onComplete={checkCode}
          error={error}
          help={env.apiMode === 'mock' ? `Demo bank: the code is always ${DEMO_OTP}.` : undefined}
          autoFocus
        />
      )}
      {!otp && error && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}

      <View style={{ gap: spacing[2] }}>
        {otp ? (
          <>
            <Button
              label="Continue"
              loading={verify.isPending}
              disabled={code.length < 6 || attemptsLeft <= 0}
              fullWidth
              onPress={() => checkCode(code)}
            />
            <Button
              label={resendIn > 0 ? `Resend code in ${formatCountdown(resendIn)}` : 'Resend code'}
              variant="secondary"
              loading={resend.isPending}
              disabled={resendIn > 0}
              fullWidth
              onPress={sendAgain}
            />
          </>
        ) : (
          <Button label="Email me a code" loading={start.isPending} fullWidth onPress={sendCode} />
        )}
        <Button label="Cancel" variant="ghost" fullWidth onPress={onCancel} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, justifyContent: 'center' },
});
