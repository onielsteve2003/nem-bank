import type { Schema } from '@nem/contracts';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { BottomSheet, Button, OtpInput, Text } from '@/components';
import { isApiError } from '@/data';
import { DEMO_OTP } from '@/data/mock';
import { formatCountdown, otpErrorMessage, useSecondsUntil } from '@/features/auth/otp';
import { env } from '@/lib/env';
import { useMoneyMutation, useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { sendErrorMessage } from '../confirm';

type Transfer = Schema<'Transfer'>;
type Challenge = Schema<'StepUpChallenge'>;

interface Props {
  transferId: string | null;
  onClose: () => void;
  /** The transfer after the bank released it. */
  onReleased: (transfer: Transfer) => void;
  /** Why the bank wants it: the risk reason, or the cooling-off delay. */
  reason: string;
}

/**
 * Step-up for a waiting transfer (TRF-6, TRF-8): the PIN was already given, so the
 * second proof is a code sent to the customer's email. The bank's short-lived
 * step-up token then releases the transfer, device-signed and idempotent.
 * Render it with `key={transferId}` so each transfer gets its own check.
 */
export function StepUpSheet({ transferId, onClose, onReleased, reason }: Props) {
  const { spacing } = useTheme();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [attemptsLeft, setAttemptsLeft] = useState(0);
  const resendIn = useSecondsUntil(challenge?.otp?.resend_available_at ?? '');

  const start = useRepoMutation('auth', 'startStepUp', { invalidates: [] });
  const resend = useRepoMutation('auth', 'resendOtp', { invalidates: [] });
  const verify = useRepoMutation('auth', 'verifyStepUp', { invalidates: [] });
  const release = useMoneyMutation('transfers', 'stepUp');
  const { mutate: startStepUp } = start;

  const begin = (id: string) =>
    startStepUp(
      { body: { purpose: 'transfer', resource_id: id } },
      {
        onSuccess: (next) => {
          setChallenge(next);
          setAttemptsLeft(next.otp?.attempts_remaining ?? 0);
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

  // Callers key the sheet by transfer, so a new transfer starts with fresh state.
  useEffect(() => {
    if (transferId) begin(transferId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `begin` is recreated each render; only a new transfer starts a new check
  }, [transferId]);

  const check = async (entered: string) => {
    if (!transferId || !challenge || verify.isPending || attemptsLeft <= 0) return;
    let token: string;
    try {
      const result = await verify.mutateAsync({
        path: { step_up_id: challenge.step_up_id },
        body: { otp_code: entered },
      });
      token = result.step_up_token;
    } catch (e) {
      const left =
        isApiError(e) && e.problem.code === 'invalid_otp' ? attemptsLeft - 1 : attemptsLeft;
      setAttemptsLeft(left);
      setError(otpErrorMessage(e as Error, left));
      setCode('');
      return;
    }
    try {
      onReleased(
        await release.mutateAsync({ path: { transfer_id: transferId }, stepUpToken: token }),
      );
    } catch (e) {
      setError(sendErrorMessage(e as Error).message);
      setCode('');
    }
  };

  const sendAgain = () => {
    if (!challenge?.otp) return;
    resend.mutate(
      { body: { challenge_id: challenge.otp.challenge_id } },
      {
        onSuccess: (fresh) => {
          setChallenge({ ...challenge, otp: fresh });
          setAttemptsLeft(fresh.attempts_remaining);
          setError(undefined);
          setCode('');
        },
        onError: () => setError("We couldn't send a new code. Try again."),
      },
    );
  };

  const busy = verify.isPending || release.isPending;

  return (
    <BottomSheet open={transferId !== null} onClose={onClose} title="One more check">
      <View style={{ gap: spacing[4] }}>
        <Text color="textMuted">{reason}</Text>
        {challenge?.otp ? (
          <>
            <Text>
              Enter the 6-digit code we sent to{' '}
              <Text variant="bodyStrong">{challenge.otp.destination_masked}</Text>.
            </Text>
            <OtpInput
              value={code}
              onChangeText={setCode}
              onComplete={(entered) => void check(entered)}
              error={error}
              help={
                env.apiMode === 'mock' ? `Demo bank: the code is always ${DEMO_OTP}.` : undefined
              }
              autoFocus
            />
            {busy ? (
              <View style={[styles.row, { gap: spacing[2] }]}>
                <ActivityIndicator size="small" />
                <Text variant="bodySmall" color="textMuted">
                  Checking and sending…
                </Text>
              </View>
            ) : (
              <Button
                label={
                  resendIn > 0
                    ? `Send a new code in ${formatCountdown(resendIn)}`
                    : 'Send a new code'
                }
                variant="ghost"
                size="sm"
                disabled={resendIn > 0 || resend.isPending}
                onPress={sendAgain}
              />
            )}
          </>
        ) : error ? (
          <>
            <Text color="danger">{error}</Text>
            <Button
              label="Try again"
              onPress={() => {
                if (!transferId) return;
                setError(undefined);
                begin(transferId);
              }}
              loading={start.isPending}
            />
          </>
        ) : (
          <View style={[styles.row, { gap: spacing[2] }]}>
            <ActivityIndicator size="small" />
            <Text color="textMuted">Sending you a code…</Text>
          </View>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
