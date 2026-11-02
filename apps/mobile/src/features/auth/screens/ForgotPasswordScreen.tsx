import type { Schema } from '@nem/contracts';
import { checkPassword, emailSchema, PASSWORD_MAX_LENGTH } from '@nem/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, OtpInput, Screen, Text, TextField, useToast } from '@/components';
import { isApiError, type ApiError } from '@/data';
import { DEMO_OTP } from '@/data/mock';
import { env } from '@/lib/env';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { PasswordStrengthMeter } from '../components/PasswordStrengthMeter';
import { SignupStepHeader } from '../components/SignupStepHeader';
import { formatCountdown, otpErrorMessage, useSecondsUntil } from '../otp';
import { useTranslation } from 'react-i18next';

/** What the user is told when the new password is refused (AUTH-9). */
export function resetErrorMessage(error: ApiError | Error, attemptsLeft: number): string {
  if (isApiError(error) && error.problem.code === 'weak_password') {
    return `${error.problem.errors?.[0]?.message ?? error.problem.title}.`;
  }
  return otpErrorMessage(error, attemptsLeft);
}

/**
 * Forgot password (AUTH-9). The emailed code is the step-up: it proves the
 * person owns the account's email before a new password is set. The bank gives
 * the same answer for unknown emails, so this cannot be used to find accounts.
 */
export function ForgotPasswordScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [challenge, setChallenge] = useState<Schema<'OtpChallenge'> | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const [attemptsLeft, setAttemptsLeft] = useState(0);
  const resendIn = useSecondsUntil(challenge?.resend_available_at ?? '');

  const start = useRepoMutation('auth', 'forgotPassword', { invalidates: [] });
  const resend = useRepoMutation('auth', 'resendOtp', { invalidates: [] });
  const reset = useRepoMutation('auth', 'resetPassword', { invalidates: [] });

  const check = useMemo(() => checkPassword(password, { email }), [password, email]);

  const sendCode = () => {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message);
      return;
    }
    setEmailError(undefined);
    start.mutate(
      { body: { email: parsed.data } },
      {
        onSuccess: (otp) => {
          setChallenge(otp);
          setAttemptsLeft(otp.attempts_remaining);
          setError(undefined);
        },
        onError: (e) =>
          setEmailError(
            isApiError(e) && e.problem.code === 'offline'
              ? t('common.offline')
              : t('common.sendCodeFailed'),
          ),
      },
    );
  };

  const sendAgain = () => {
    if (!challenge) return;
    resend.mutate(
      { body: { challenge_id: challenge.challenge_id } },
      {
        onSuccess: (fresh) => {
          setChallenge(fresh);
          setAttemptsLeft(fresh.attempts_remaining);
          setCode('');
          setError(undefined);
        },
        onError: () => setError(t('common.resendFailed')),
      },
    );
  };

  const save = () => {
    setSubmitted(true);
    if (!challenge || code.length < 6 || !check.acceptable || attemptsLeft <= 0) return;
    reset.mutate(
      { body: { challenge_id: challenge.challenge_id, code, new_password: password } },
      {
        onSuccess: () => {
          toast.show({
            message: t('auth.forgot.changed'),
            tone: 'success',
          });
          router.back();
        },
        onError: (e) => {
          const problemCode = isApiError(e) ? e.problem.code : '';
          const left =
            problemCode === 'invalid_otp'
              ? attemptsLeft - 1
              : ['rate_limited', 'otp_expired', 'not_found'].includes(problemCode)
                ? 0
                : attemptsLeft;
          setAttemptsLeft(left);
          setError(resetErrorMessage(e, left));
          if (problemCode !== 'weak_password') setCode('');
        },
      },
    );
  };

  if (!challenge) {
    const footer = (
      <View style={{ padding: spacing[4] }}>
        <Button
          label={t('auth.forgot.sendCode')}
          loading={start.isPending}
          fullWidth
          onPress={sendCode}
        />
      </View>
    );
    return (
      <Screen
        header={<SignupStepHeader label={t('auth.forgot.header')} />}
        footer={footer}
        padded
        edges={['top', 'bottom']}
      >
        <View style={{ gap: spacing[2] }}>
          <Text variant="h1">{t('auth.forgot.title')}</Text>
          <Text color="textMuted">{t('auth.forgot.intro')}</Text>
        </View>
        <TextField
          label={t('auth.signup.email')}
          value={email}
          onChangeText={setEmail}
          error={emailError}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="send"
          onSubmitEditing={sendCode}
          autoFocus
        />
      </Screen>
    );
  }

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      <Button
        label={t('auth.forgot.save')}
        loading={reset.isPending}
        disabled={attemptsLeft <= 0}
        fullWidth
        onPress={save}
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
    <Screen
      header={<SignupStepHeader label={t('auth.forgot.header')} />}
      footer={footer}
      padded
      edges={['top', 'bottom']}
    >
      <View style={{ gap: spacing[2] }}>
        <Text variant="h1">{t('auth.forgot.chooseTitle')}</Text>
        <Text color="textMuted">
          {t('auth.forgot.chooseIntro', { destination: challenge.destination_masked })}
        </Text>
      </View>

      <OtpInput
        value={code}
        onChangeText={(next) => {
          setCode(next);
          if (error && attemptsLeft > 0) setError(undefined);
        }}
        error={error}
        help={env.apiMode === 'mock' ? t('common.demoOtp', { code: DEMO_OTP }) : undefined}
        autoFocus
      />

      <View style={{ gap: spacing[3] }}>
        <TextField
          label={t('auth.forgot.newPassword')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          passwordRules={`minlength: 10; maxlength: ${PASSWORD_MAX_LENGTH};`}
          maxLength={PASSWORD_MAX_LENGTH}
          error={submitted && !check.acceptable ? check.problems[0] : undefined}
          returnKeyType="done"
          onSubmitEditing={save}
        />
        {password.length > 0 && <PasswordStrengthMeter check={check} />}
        <Text variant="bodySmall" color="textMuted">
          {t('auth.forgot.signsOut')}
        </Text>
      </View>
    </Screen>
  );
}
