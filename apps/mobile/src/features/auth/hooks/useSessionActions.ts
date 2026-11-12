import { useQueryClient } from '@tanstack/react-query';
import type { Schema } from '@nem/contracts';
import { useCallback } from 'react';

import { useRepositories } from '@/data';
import { createDeviceKey, getDeviceKeyInfo, setDeviceId } from '@/lib/deviceKey';
import { env } from '@/lib/env';
import { useRepoMutation } from '@/lib/query';
import { useSessionStore } from '@/stores';

import { deviceRegistration } from '../device';

type Persona = NonNullable<Schema<'DemoSessionRequest'>['persona']>;

/** The persona a demo customer was started as, read back from its first name. */
const PERSONA_BY_FIRST_NAME: Record<string, Persona> = {
  Tolulope: 'tolu',
  Ngozi: 'mama_ngozi',
  Emeka: 'emeka',
  Bisola: 'bisi',
};

/**
 * The request for a demo session. The real bank makes a fresh demo customer for this
 * phone's own device key, so its money requests can be signed here; the offline demo
 * needs no device.
 */
async function demoBody(persona: Persona): Promise<Schema<'DemoSessionRequest'>> {
  if (env.apiMode !== 'http') return { persona };
  const key = (await getDeviceKeyInfo()) ?? (await createDeviceKey({ biometric: false }));
  return { persona, device: deviceRegistration(key) };
}

/** Remembers the device the bank bound, so later sign-ins reuse it. */
async function rememberDevice(auth: Schema<'AuthSession'>): Promise<void> {
  if (env.apiMode === 'http') await setDeviceId(auth.device.id);
}

/** One tap into the seeded demo persona (AUTH-11). The route gate then opens Home. */
export function useDemoSignIn() {
  const setSession = useSessionStore((s) => s.setSession);
  const mutation = useRepoMutation('auth', 'startDemoSession', {
    invalidates: [],
    onSuccess: async (auth) => {
      await rememberDevice(auth);
      setSession(auth);
    },
  });
  const { mutate } = mutation;
  const start = useCallback(
    (persona: Persona) => {
      // If the device key cannot be made, ask without it: the bank answers that a device is
      // required, and the Welcome screen shows that instead of doing nothing.
      void demoBody(persona)
        .catch(() => ({ persona }))
        .then((body) => mutate({ body }));
    },
    [mutate],
  );
  return { ...mutation, start };
}

/**
 * Starts the demo customer over (Demo Controls, Reset). The real bank cannot rewind a
 * ledger, so it makes a fresh customer with the same persona and swaps the session.
 */
export function useRestartDemo(): () => Promise<void> {
  const repos = useRepositories();
  return useCallback(async () => {
    const me = await repos.users.getMe({}).catch(() => null);
    const persona = PERSONA_BY_FIRST_NAME[me?.first_name ?? ''] ?? 'tolu';
    const auth = await repos.auth.startDemoSession({ body: await demoBody(persona) });
    await rememberDevice(auth);
    useSessionStore.getState().setSession(auth);
  }, [repos]);
}

/**
 * Signs out on this device, or on every device (a login the user does not
 * recognise). The server is told best-effort: a failed logout call must never
 * leave the user stuck signed in. The query cache is cleared so the next person
 * on this phone cannot see the last one's balances, even offline.
 */
export function useSignOut(): (options?: { allDevices?: boolean }) => Promise<void> {
  const repos = useRepositories();
  const client = useQueryClient();
  return useCallback(
    async (options) => {
      if (useSessionStore.getState().session) {
        await repos.auth
          .logout({ body: { all_devices: options?.allDevices === true } })
          .catch(() => undefined);
      }
      useSessionStore.getState().signOut();
      client.clear();
    },
    [repos, client],
  );
}
