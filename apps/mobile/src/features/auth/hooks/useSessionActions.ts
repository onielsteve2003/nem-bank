import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useRepositories } from '@/data';
import { useRepoMutation } from '@/lib/query';
import { useSessionStore } from '@/stores';

/** One tap into the seeded demo persona (AUTH-11). The route gate then opens Home. */
export function useDemoSignIn() {
  const setSession = useSessionStore((s) => s.setSession);
  return useRepoMutation('auth', 'startDemoSession', {
    invalidates: [],
    onSuccess: (auth) => setSession(auth),
  });
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
