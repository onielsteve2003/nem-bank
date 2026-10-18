import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Privacy mode (PRD ACC-4, SET-5): masks every balance and amount, for using the
// app on a bus or with someone looking over your shoulder. Its own store because
// every MoneyText reads it.

export interface PrivacyState {
  balancesHidden: boolean;
  setBalancesHidden: (hidden: boolean) => void;
  toggleBalances: () => void;
}

export const usePrivacyStore = create<PrivacyState>()(
  persist(
    (set) => ({
      balancesHidden: false,
      setBalancesHidden: (balancesHidden) => set({ balancesHidden }),
      toggleBalances: () => set((s) => ({ balancesHidden: !s.balancesHidden })),
    }),
    {
      name: 'nem-privacy',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ balancesHidden: s.balancesHidden }),
    },
  ),
);

/** For components: `const hidden = useBalancesHidden();` */
export const useBalancesHidden = () => usePrivacyStore((s) => s.balancesHidden);
