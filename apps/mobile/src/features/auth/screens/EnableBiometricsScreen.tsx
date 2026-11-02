import { Redirect } from 'expo-router';
import { Fingerprint, KeyRound, ScanFace, ShieldCheck, type LucideIcon } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, Icon, Screen, Text } from '@/components';
import { isApiError } from '@/data';
import {
  authenticateWithBiometrics,
  getBiometrics,
  NO_BIOMETRICS,
  type Biometrics,
} from '@/lib/biometrics';
import { createDeviceKey, setDeviceId } from '@/lib/deviceKey';
import { useRepoMutation } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { SignupStepHeader } from '../components/SignupStepHeader';
import { deviceRegistration } from '../device';
import { useSignupStore } from '../signupStore';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';

function finishErrorMessage(error: unknown): string {
  if (!isApiError(error)) return i18n.t('auth.biometrics.setupFailed');
  switch (error.problem.code) {
    case 'weak_password':
    case 'weak_pin':
      return i18n.t('auth.biometrics.goBack', { problem: error.problem.title });
    case 'invalid_otp':
      return i18n.t('auth.biometrics.emailExpired');
    case 'offline':
      return i18n.t('common.offline');
    default:
      return i18n.t('common.problemTryAgain', { problem: error.problem.title });
  }
}

/**
 * The last screen of sign-up (AUTH-5, AUTH-6). Makes this device's key pair, with
 * the private key behind Face ID / fingerprint if the user opts in, then creates
 * the account in one call. Storing the session opens Home through the route gate.
 */
export function EnableBiometricsScreen() {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  // A snapshot: clearing the store on success must not redirect this screen mid-exit.
  const [signup] = useState(() => useSignupStore.getState().pending);
  const setSession = useSessionStore((s) => s.setSession);
  const [biometrics, setBiometrics] = useState<Biometrics | null>(null);
  const [busy, setBusy] = useState<'on' | 'off' | null>(null);
  const [error, setError] = useState<string>();
  const complete = useRepoMutation('auth', 'completeSignup', { invalidates: [] });

  useEffect(() => {
    let live = true;
    void getBiometrics().then((found) => live && setBiometrics(found));
    return () => {
      live = false;
    };
  }, []);

  if (!signup?.verificationToken || !signup.password || !signup.pin) {
    return <Redirect href="/sign-up" />;
  }
  const found = biometrics ?? NO_BIOMETRICS;
  const label = found.label;

  const finish = async (biometric: boolean) => {
    setError(undefined);
    setBusy(biometric ? 'on' : 'off');
    try {
      // Confirm the face or finger now, so a failed scan never leaves a key nobody can read.
      if (
        biometric &&
        !(await authenticateWithBiometrics(t('auth.biometrics.prompt', { label })))
      ) {
        setError(t('auth.biometrics.notConfirmed', { label }));
        return;
      }
      const key = await createDeviceKey({ biometric });
      const session = await complete.mutateAsync({
        body: {
          signup_id: signup.signup_id,
          verification_token: signup.verificationToken!,
          password: signup.password!,
          pin: signup.pin,
          device: deviceRegistration(key, signup.request.first_name),
        },
      });
      await setDeviceId(session.device.id);
      useSignupStore.getState().clear();
      setSession(session);
    } catch (e) {
      setError(finishErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const BiometricIcon: LucideIcon = label === 'Face ID' ? ScanFace : Fingerprint;
  const checking = biometrics === null;

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}
      {found.available ? (
        <>
          <Button
            label={t('auth.biometrics.turnOn', { label })}
            loading={busy === 'on'}
            disabled={busy !== null}
            fullWidth
            onPress={() => void finish(true)}
          />
          <Button
            label={t('auth.biometrics.notNow')}
            variant="ghost"
            loading={busy === 'off'}
            disabled={busy !== null}
            fullWidth
            onPress={() => void finish(false)}
          />
        </>
      ) : (
        <Button
          label={t('auth.biometrics.openAccount')}
          loading={busy === 'off'}
          disabled={checking || busy !== null}
          fullWidth
          onPress={() => void finish(false)}
        />
      )}
    </View>
  );

  return (
    <Screen header={<SignupStepHeader />} footer={footer} padded edges={['top', 'bottom']}>
      {found.available ? (
        <>
          <View style={{ gap: spacing[3] }}>
            <Icon icon={BiometricIcon} size="xl" color="primaryText" />
            <Text variant="h1">{t('auth.biometrics.title', { label })}</Text>
            <Text color="textMuted">{t('auth.biometrics.intro', { label })}</Text>
          </View>
          <View style={{ gap: spacing[3] }}>
            <Point icon={ShieldCheck}>
              {label === 'Face ID'
                ? t('auth.biometrics.privateFace')
                : t('auth.biometrics.privateFinger')}
            </Point>
            <Point icon={KeyRound}>{t('auth.biometrics.key', { label })}</Point>
          </View>
        </>
      ) : (
        <View style={{ gap: spacing[3] }}>
          <Icon icon={KeyRound} size="xl" color="primaryText" />
          <Text variant="h1">{t('auth.biometrics.finish')}</Text>
          <Text color="textMuted">
            {checking
              ? t('auth.biometrics.checking')
              : found.blockedBy === 'expoGo'
                ? t('auth.biometrics.expoGo')
                : Platform.OS === 'web'
                  ? t('auth.biometrics.web')
                  : t('auth.biometrics.none')}
          </Text>
        </View>
      )}
    </Screen>
  );
}

function Point({ icon, children }: { icon: LucideIcon; children: string }) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.point, { gap: spacing[3] }]}>
      <Icon icon={icon} size="md" color="textMuted" />
      <Text color="textMuted" style={styles.flex}>
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  point: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
});
