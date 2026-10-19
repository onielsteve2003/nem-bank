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

function finishErrorMessage(error: unknown): string {
  if (!isApiError(error)) return "We couldn't set up this device. Try again.";
  switch (error.problem.code) {
    case 'weak_password':
    case 'weak_pin':
      return `${error.problem.title}. Go back and change it.`;
    case 'invalid_otp':
      return 'Your email check has expired. Start sign-up again.';
    case 'offline':
      return "You're offline. Reconnect and try again.";
    default:
      return `${error.problem.title}. Try again.`;
  }
}

/**
 * The last screen of sign-up (AUTH-5, AUTH-6). Makes this device's key pair, with
 * the private key behind Face ID / fingerprint if the user opts in, then creates
 * the account in one call. Storing the session opens Home through the route gate.
 */
export function EnableBiometricsScreen() {
  const { spacing } = useTheme();
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
      if (biometric && !(await authenticateWithBiometrics(`Turn on ${label} for Nem Bank`))) {
        setError(`${label} wasn't confirmed. Try again, or choose Not now.`);
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
            label={`Turn on ${label}`}
            loading={busy === 'on'}
            disabled={busy !== null}
            fullWidth
            onPress={() => void finish(true)}
          />
          <Button
            label="Not now"
            variant="ghost"
            loading={busy === 'off'}
            disabled={busy !== null}
            fullWidth
            onPress={() => void finish(false)}
          />
        </>
      ) : (
        <Button
          label="Open my account"
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
            <Text variant="h1">Use {label}?</Text>
            <Text color="textMuted">
              Unlock the app and approve payments with {label} instead of typing your PIN.
            </Text>
          </View>
          <View style={{ gap: spacing[3] }}>
            <Point icon={ShieldCheck}>
              Your {label === 'Face ID' ? 'face' : 'fingerprint'} never leaves this phone. Nem Bank
              only learns that the check passed.
            </Point>
            <Point icon={KeyRound}>
              This phone gets its own security key, locked behind {label}, so payments can only be
              approved from here.
            </Point>
          </View>
        </>
      ) : (
        <View style={{ gap: spacing[3] }}>
          <Icon icon={KeyRound} size="xl" color="primaryText" />
          <Text variant="h1">Finish setting up</Text>
          <Text color="textMuted">
            {checking
              ? 'Checking this device…'
              : Platform.OS === 'web'
                ? 'Browsers cannot use Face ID or fingerprints, so you will use your PIN here. The phone app supports both.'
                : 'No Face ID or fingerprint is set up on this device, so you will use your PIN. You can turn it on later in Security.'}
          </Text>
        </View>
      )}
    </Screen>
  );
}

function Point({ icon, children }: { icon: LucideIcon; children: string | string[] }) {
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
