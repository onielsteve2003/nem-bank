import type { StaffRole } from '@nem/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { useDemoControls, useRepositories } from '@/data/provider';

import { useSession } from './session';

export function useStaffLogin() {
  const { auth } = useRepositories();
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => auth.login({ body }),
  });
}

export function useVerifyTotp() {
  const { auth } = useRepositories();
  const signIn = useSession((s) => s.signIn);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { challenge_id: string; code: string }) => auth.verifyTotp({ body }),
    onSuccess: (session) => {
      queryClient.clear();
      signIn(session);
    },
  });
}

/** Revokes the session at the bank, then forgets it here even if that call fails. */
export function useSignOut() {
  const { auth } = useRepositories();
  const signOut = useSession((s) => s.signOut);
  const queryClient = useQueryClient();
  return useCallback(async () => {
    try {
      await auth.logout();
    } finally {
      // The shell sees the session go and moves to login.
      signOut();
      queryClient.clear();
    }
  }, [auth, signOut, queryClient]);
}

/** Demo only: re-sign-in as another role. Null against the real API. */
export function useSwitchRole(): ((role: StaffRole) => void) | null {
  const demo = useDemoControls();
  const signIn = useSession((s) => s.signIn);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const switchRole = useCallback(
    (role: StaffRole) => {
      if (!demo) return;
      signIn(demo.switchRole(role));
      // Back to a page every role can open, then refetch everything as the new role.
      void navigate({ to: '/' });
      void queryClient.resetQueries();
    },
    [demo, signIn, queryClient, navigate],
  );
  return demo ? switchRole : null;
}
