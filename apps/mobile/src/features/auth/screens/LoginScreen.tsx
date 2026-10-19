import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { Fingerprint, ScanFace } from 'lucide-react-native';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { Button, Divider, Screen, Text, TextField } from '@/components';
import { DEMO_PASSWORD } from '@/data/mock';
import { env } from '@/lib/env';
import { useTheme } from '@/theme';

import { SignupStepHeader } from '../components/SignupStepHeader';
import { usePasswordLogin, useQuickLogin, useQuickLoginOffer } from '../hooks/useLogin';
import {
  loginErrorMessage,
  loginFormSchema,
  type LoginFormInput,
  type LoginFormValues,
} from '../loginForm';

const DEMO_EMAIL = 'tolu.demo@example.com';

/**
 * Login (AUTH-7). On a phone already bound with Face ID / fingerprint the scan
 * is offered once on arrival; the password form is always there underneath.
 * Storing the session opens Home through the route gate.
 */
export function LoginScreen() {
  const { spacing } = useTheme();
  const router = useRouter();
  const passwordLogin = usePasswordLogin();
  const quickLogin = useQuickLogin();
  const offer = useQuickLoginOffer();
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState<string>();
  const prompted = useRef(false);

  const {
    control,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormInput, unknown, LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { identifier: '', password: '' },
    mode: 'onTouched',
  });

  const submit = handleSubmit(async (values) => {
    setQuickError(undefined);
    try {
      await passwordLogin(values);
    } catch (error) {
      setError('root.server', { message: loginErrorMessage(error) });
    }
  });

  const runQuickLogin = async () => {
    if (!offer?.available || quickBusy) return;
    setQuickError(undefined);
    setQuickBusy(true);
    try {
      if (!(await quickLogin())) {
        setQuickError(`${offer.label} wasn't confirmed. Try again, or use your password.`);
      }
    } catch {
      setQuickError(`${offer.label} login isn't working right now. Use your password.`);
    } finally {
      setQuickBusy(false);
    }
  };

  // Offer the scan once, as the lock screen does; cancelling leaves the form.
  const promptOnArrival = useEffectEvent(() => void runQuickLogin());
  useEffect(() => {
    if (offer?.available && !prompted.current) {
      prompted.current = true;
      promptOnArrival();
    }
  }, [offer]);

  const busy = isSubmitting || quickBusy;
  const BiometricIcon = offer?.label === 'Face ID' ? ScanFace : Fingerprint;

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      {errors.root?.server && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {errors.root.server.message}
        </Text>
      )}
      <Button
        label="Log in"
        loading={isSubmitting}
        disabled={busy}
        fullWidth
        onPress={() => void submit()}
      />
    </View>
  );

  return (
    <Screen
      header={<SignupStepHeader label="Log in" />}
      footer={footer}
      padded
      edges={['top', 'bottom']}
    >
      <View style={{ gap: spacing[2] }}>
        <Text variant="h1">Welcome back</Text>
        <Text color="textMuted">Log in with your email or phone number and your password.</Text>
      </View>

      {offer?.available && (
        <View style={{ gap: spacing[3] }}>
          <Button
            label={`Log in with ${offer.label}`}
            icon={BiometricIcon}
            variant="secondary"
            loading={quickBusy}
            disabled={busy}
            fullWidth
            onPress={() => void runQuickLogin()}
          />
          {quickError && (
            <Text variant="bodySmall" color="danger" accessibilityRole="alert">
              {quickError}
            </Text>
          )}
          <Divider label="or use your password" />
        </View>
      )}

      <View style={{ gap: spacing[4] }}>
        <Controller
          control={control}
          name="identifier"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label="Email or phone number"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.identifier?.message}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => setFocus('password')}
            />
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label="Password"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.password?.message}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              textContentType="password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
            />
          )}
        />
        <Button
          label="Forgot password?"
          variant="ghost"
          size="sm"
          onPress={() => router.push('/forgot-password')}
          style={{ alignSelf: 'flex-start' }}
        />
        {env.apiMode === 'mock' && (
          <Text variant="bodySmall" color="textMuted">
            Demo bank: log in as {DEMO_EMAIL} with {DEMO_PASSWORD}, or with the details you signed
            up with.
          </Text>
        )}
      </View>
    </Screen>
  );
}
