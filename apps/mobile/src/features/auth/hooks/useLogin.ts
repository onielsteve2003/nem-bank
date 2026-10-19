import { useCallback, useEffect, useState } from 'react';

import { useRepositories } from '@/data';
import { getBiometrics, NO_BIOMETRICS, type Biometrics } from '@/lib/biometrics';
import { createDeviceKey, getDeviceKeyInfo, setDeviceId, signWithDeviceKey } from '@/lib/deviceKey';
import { useLockStore, useSessionStore } from '@/stores';

import { deviceRegistration } from '../device';

import type { LoginFormValues } from '../loginForm';

/**
 * Password login (AUTH-7). A device the bank already knows sends its ID; one it
 * does not (a new phone, or a key the bank has never seen) registers its public
 * key, and the bank starts the 24-hour new-device cool-off (AUTH-8).
 */
export function usePasswordLogin() {
  const repos = useRepositories();
  const setSession = useSessionStore((s) => s.setSession);
  return useCallback(
    async ({ identifier, password }: LoginFormValues) => {
      // A new device's key stays PIN-only: biometrics are turned on from Security.
      const key = (await getDeviceKeyInfo()) ?? (await createDeviceKey({ biometric: false }));
      const auth = await repos.auth.login({
        body: {
          identifier,
          password,
          ...(key.deviceId ? { device_id: key.deviceId } : {}),
          device: deviceRegistration(key),
        },
      });
      await setDeviceId(auth.device.id);
      setSession(auth, { newDevice: auth.device.id !== key.deviceId });
    },
    [repos, setSession],
  );
}

/**
 * Face ID / fingerprint is offered only on a device that is already bound and
 * whose key the user put behind biometrics at sign-up (AUTH-5).
 */
export function useQuickLoginOffer(): Biometrics | null {
  const [offer, setOffer] = useState<Biometrics | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([getBiometrics(), getDeviceKeyInfo()]).then(([found, key]) => {
      if (live) setOffer(found.available && key?.biometric && key.deviceId ? found : NO_BIOMETRICS);
    });
    return () => {
      live = false;
    };
  }, []);
  return offer;
}

/**
 * Biometric quick login: the bank sends a one-time nonce, this device signs it
 * with the key behind Face ID, and the bank checks it against the bound public
 * key. Resolves false when the user cancels the scan.
 */
export function useQuickLogin() {
  const repos = useRepositories();
  const setSession = useSessionStore((s) => s.setSession);
  const setAuthenticating = useLockStore((s) => s.setAuthenticating);
  return useCallback(async (): Promise<boolean> => {
    const key = await getDeviceKeyInfo();
    if (!key?.deviceId) throw new Error('This device is not bound yet');
    const challenge = await repos.auth.createDeviceChallenge({
      body: { device_id: key.deviceId },
    });
    let signature: string;
    // The system prompt makes the app inactive; this keeps the privacy cover away.
    setAuthenticating(true);
    try {
      signature = await signWithDeviceKey(challenge.nonce, 'Log in to Nem Bank');
    } catch {
      return false;
    } finally {
      setAuthenticating(false);
    }
    const auth = await repos.auth.loginWithDevice({
      body: { device_id: key.deviceId, challenge_id: challenge.challenge_id, signature },
    });
    setSession(auth, { newDevice: false });
    return true;
  }, [repos, setSession, setAuthenticating]);
}
