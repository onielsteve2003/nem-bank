import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, OtpInput, PaidFeatureNotice, Screen, Text } from '@/components';
import { isApiError } from '@/data';
import { DEMO_OTP } from '@/data/mock';
import { env } from '@/lib/env';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { SignupStepHeader } from '../components/SignupStepHeader';
import { formatCountdown, otpErrorMessage, useSecondsUntil } from '../otp';
import { useSignupStore } from '../signupStore';
import { useTranslation } from 'react-i18next';

/** Step 2 of sign-up: the 6-digit email code (AUTH-2). SMS is a paid feature. */
export function VerifyEmailScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
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
          setNotice(t('auth.verify.sentAgain', { destination: fresh.destination_masked }));
        },
        onError: (e) =>
          setError(
            isApiError(e) && e.problem.code === 'rate_limited'
              ? t('auth.verify.wait')
              : t('common.resendFailed'),
          ),
      },
    );
  };

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      <Button
        label={t('auth.verify.verify')}
        loading={verify.isPending}
        disabled={code.length < 6 || outOfAttempts}
        fullWidth
        onPress={() => submit(code)}
      />
      <Button
        label={
          resendIn > 0
            ? t('common.resendCodeIn', { time: formatCountdown(resendIn) })
            : t('common.resendCode')
        }
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
        <Text variant="h1">{t('auth.verify.title')}</Text>
        <Text color="textMuted">
          {t('auth.verify.intro', { destination: otp.destination_masked })}
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
        help={env.apiMode === 'mock' ? t('common.demoOtp', { code: DEMO_OTP }) : undefined}
        autoFocus
      />

      {notice && (
        <Text variant="bodySmall" color="success" accessibilityRole="alert">
          {notice}
        </Text>
      )}

      <Button
        label={t('auth.verify.sms')}
        variant="ghost"
        size="sm"
        onPress={() => setSmsOpen(true)}
        style={{ alignSelf: 'flex-start' }}
      />
      <PaidFeatureNotice open={smsOpen} onClose={() => setSmsOpen(false)} feature="smsOtp" />
    </Screen>
  );
}
