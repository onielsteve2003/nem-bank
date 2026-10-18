import type { Href } from 'expo-router';
import { create } from 'zustand';

import { useSessionStore } from './session';

// A link opened while signed out (a pay link from WhatsApp, an ajo invite) is
// kept here, then opened once the user signs in, instead of being lost at the
// auth gate. Memory only: a link from last week should not reopen on next launch.

export interface DeepLinkState {
  pending: Href | null;
  setPending: (href: Href | null) => void;
}

export const useDeepLinkStore = create<DeepLinkState>()((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));

// Signing out drops any link that was waiting, so it cannot open for the next person.
useSessionStore.subscribe((state, prev) => {
  if (prev.status === 'signedIn' && state.status === 'signedOut') {
    useDeepLinkStore.getState().setPending(null);
  }
});
