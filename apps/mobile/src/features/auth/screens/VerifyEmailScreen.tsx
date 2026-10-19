import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, OtpInput, PaidFeatureNotice, Screen, Text } from '@/components';
import { isApiError, type ApiError } from '@/data';
import { DEMO_OTP } from '@/data/mock';
import { env } from '@/lib/env';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { SignupStepHeader } from '../components/SignupStepHeader';
import { useSignupStore } from '../signupStore';

/** Whole seconds until `iso`, ticking once a second; 0 once it has passed. */
export function useSecondsUntil(iso: string): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Rounded, not ceiled: a fresh 60 s cooldown read a moment late still says 1:00.
  return Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** What the user is told for a failed check. Attempts come from the challenge (AUTH-2). */
export function otpErrorMessage(error: ApiError | Error, attemptsLeft: number): string {
  if (!isApiError(error)) return "We couldn't check the code. Try again.";
  switch (error.problem.code) {
    case 'invalid_otp':
      return attemptsLeft > 0
        ? `That code is not right. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`
        : 'That code is not right, and that was the last try. Ask for a new code.';
    case 'otp_expired':
    case 'not_found':
      return 'This code has expired. Ask for a new one.';
    case 'rate_limited':
      return 'Too many wrong codes. Ask for a new one.';
    case 'offline':
      return "You're offline. Reconnect and try again.";
    default:
      return "We couldn't check the code. Try again.";
  }
}

/** Step 2 of sign-up: the 6-digit email code (AUTH-2). SMS is a paid feature. */
export function VerifyEmailScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const pending = useSignupStore((s) => s.pending);
  const setOtp = useSignupStore((s) => s.setOtp);
  const markVerified = useSignupStore((s) => s.verified);

  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [attemptsLeft, setAttemptsLeft] = useState(pending?.otp.attempts_remaining ?? 0);
  const [smsOpen, setSmsOpen] = useState(false);
  const resendIn = useSecondsUntil(pending?.otp.resend_available_at ?? '');

  const verify = useRepoMutation('auth', 'verifyOtp', { invalidates: [] });
  const resend = useRepoMutation('auth', 'resendOtp', { invalidates: [] });

  // Sign-up lives in memory: after a restart there is nothing to verify.
  if (!pending) return <Redirect href="/sign-up" />;
  const { otp } = pending;
  const outOfAttempts = attemptsLeft <= 0;

  const submit = (entered: string) => {
    if (verify.isPending || outOfAttempts) return;
    setNotice(undefined);
    verify.mutate(
      { body: { challenge_id: otp.challenge_id, code: entered } },
      {
        onSuccess: (result) => {
          setError(undefined);
          markVerified(result.verification_token);
          router.push('/create-password');
        },
        onError: (e) => {
          const code = isApiError(e) ? e.problem.code : '';
          const left =
            code === 'invalid_otp'
              ? attemptsLeft - 1
              : ['rate_limited', 'otp_expired', 'not_found'].includes(code)
                ? 0
                : attemptsLeft;
          setAttemptsLeft(left);
          setError(otpErrorMessage(e, left));
          setCode('');
        },
      },
    );
  };

  const sendAgain = () => {
    resend.mutate(
      { body: { challenge_id: otp.challenge_id } },
      {
        onSuccess: (fresh) => {
          setOtp(fresh);
          setAttemptsLeft(fresh.attempts_remaining);
          setError(undefined);
          setCode('');
          setNotice(`We sent a new code to ${fresh.destination_masked}.`);
        },
        onError: (e) =>
          setError(
            isApiError(e) && e.problem.code === 'rate_limited'
              ? 'Wait a moment before asking for another code.'
              : "We couldn't send a new code. Try again.",
          ),
      },
    );
  };

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      <Button
        label="Verify"
        loading={verify.isPending}
        disabled={code.length < 6 || outOfAttempts}
        fullWidth
        onPress={() => submit(code)}
      />
      <Button
        label={resendIn > 0 ? `Resend code in ${formatCountdown(resendIn)}` : 'Resend code'}
        variant="secondary"
        loading={resend.isPending}
        disabled={resendIn > 0}
        fullWidth
        onPress={sendAgain}
      />
    </View>
  );

  return (
    <Screen header={<SignupStepHeader step={2} />} footer={footer} padded edges={['top', 'bottom']}>
      <View style={{ gap: spacing[2] }}>
        <Text variant="h1">Check your email</Text>
        <Text color="textMuted">
          Enter the 6-digit code we sent to {otp.destination_masked}. It works for 10 minutes.
        </Text>
      </View>

      <OtpInput
        value={code}
        onChangeText={(next) => {
          setCode(next);
          if (error && !outOfAttempts) setError(undefined);
        }}
        onComplete={submit}
        error={error}
        help={env.apiMode === 'mock' ? `Demo bank: the code is always ${DEMO_OTP}.` : undefined}
        autoFocus
      />

      {notice && (
        <Text variant="bodySmall" color="success" accessibilityRole="alert">
          {notice}
        </Text>
      )}

      <Button
        label="Use SMS instead"
        variant="ghost"
        size="sm"
        onPress={() => setSmsOpen(true)}
        style={{ alignSelf: 'flex-start' }}
      />
      <PaidFeatureNotice open={smsOpen} onClose={() => setSmsOpen(false)} feature="smsOtp" />
    </Screen>
  );
}
