import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Kid mode goals (FAM-1): what a child is saving towards, measured against their
// balance. Kept on this device until the backend has a goals endpoint for
// dependants (Phase 2).

export interface KidGoal {
  id: string;
  name: string;
  emoji: string;
  /** Target in kobo, as a string so it survives JSON. */
  targetMinor: string;
}

export interface KidGoalsState {
  goals: Record<string, KidGoal[]>;
  addGoal: (dependantId: string, goal: Omit<KidGoal, 'id'>) => void;
  removeGoal: (dependantId: string, goalId: string) => void;
}

export const useKidGoalsStore = create<KidGoalsState>()(
  persist(
    (set) => ({
      goals: {},
      addGoal: (dependantId, goal) =>
        set((s) => ({
          goals: {
            ...s.goals,
            [dependantId]: [
              ...(s.goals[dependantId] ?? []),
              { ...goal, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
            ],
          },
        })),
      removeGoal: (dependantId, goalId) =>
        set((s) => ({
          goals: {
            ...s.goals,
            [dependantId]: (s.goals[dependantId] ?? []).filter((g) => g.id !== goalId),
          },
        })),
    }),
    {
      name: 'nem-kid-goals',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ goals: s.goals }),
    },
  ),
);
