import { Fingerprint, ScanFace, Zap } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Icon, PinPad, Text } from '@/components';
import { isApiError } from '@/data';
import { DEMO_PIN } from '@/data/mock';
import { useSignOut } from '@/features/auth/hooks/useSessionActions';
import { authenticateWithBiometrics, getBiometrics, NO_BIOMETRICS } from '@/lib/biometrics';
import { useRepoMutation } from '@/lib/query';
import { useSecureScreen } from '@/lib/screenCapture';
import { useLockStore, useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { pinErrorMessage } from './pinErrors';

/**
 * Unlocks the app with Face ID / fingerprint or the transaction PIN (AUTH-5,
 * AUTH-12). The PIN is checked by the bank, which owns attempts and lockout
 * (AUTH-4). Biometrics are offered once on arrival; "Use PIN" cancels to the pad.
 */
export function LockScreen() {
  const { colors, spacing } = useTheme();
  const unlock = useLockStore((s) => s.unlock);
  const setAuthenticating = useLockStore((s) => s.setAuthenticating);
  const isDemo = useSessionStore((s) => s.session?.isDemo ?? false);
  const signOut = useSignOut();
  const verify = useRepoMutation('users', 'verifyPin', { invalidates: [] });
  const [error, setError] = useState<string>();
  const [biometrics, setBiometrics] = useState(NO_BIOMETRICS);
  const prompted = useRef(false);
  useSecureScreen();

  const tryBiometrics = useCallback(
    async (label: string) => {
      setAuthenticating(true);
      const ok = await authenticateWithBiometrics(`Unlock Nem Bank with ${label}`);
      setAuthenticating(false);
      if (ok) unlock();
    },
    [setAuthenticating, unlock],
  );

  useEffect(() => {
    let cancelled = false;
    void getBiometrics().then((found) => {
      if (cancelled) return;
      setBiometrics(found);
      if (found.available && !prompted.current) {
        prompted.current = true;
        void tryBiometrics(found.label);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tryBiometrics]);

  const onComplete = async (pin: string) => {
    try {
      const result = await verify.mutateAsync({ body: { pin } });
      if (result.valid) {
        setError(undefined);
        unlock();
        return true;
      }
      setError(pinErrorMessage(result));
    } catch (e) {
      setError(
        isApiError(e) && e.problem.code === 'offline'
          ? "You're offline, so your PIN can't be checked. Reconnect and try again."
          : "We couldn't check your PIN. Try again.",
      );
    }
    return false;
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.brand, { gap: spacing[1], paddingTop: spacing[6] }]}>
        <Icon icon={Zap} size="sm" color="primaryText" />
        <Text variant="label" color="primaryText" style={styles.brandText}>
          Nem Bank
        </Text>
      </View>
      <View style={styles.pad}>
        <PinPad
          title="Welcome back"
          subtitle={isDemo ? `Enter your PIN. Demo PIN is ${DEMO_PIN}` : 'Enter your PIN to unlock'}
          error={error}
          onComplete={onComplete}
          accessory={
            biometrics.available
              ? {
                  icon: biometrics.label === 'Face ID' ? ScanFace : Fingerprint,
                  accessibilityLabel: `Use ${biometrics.label}`,
                  onPress: () => void tryBiometrics(biometrics.label),
                }
              : undefined
          }
        />
      </View>
      <Button
        label="Sign out"
        variant="ghost"
        size="sm"
        onPress={() => void signOut()}
        style={{ alignSelf: 'center', marginBottom: spacing[4] }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: StyleSheet.absoluteFill,
  brand: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  brandText: { letterSpacing: 2, textTransform: 'uppercase' },
  pad: { flex: 1, justifyContent: 'center' },
});
