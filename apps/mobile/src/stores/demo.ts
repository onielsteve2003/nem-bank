import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  DEFAULT_SIMULATION,
  type Simulation,
  type SimulationSettings,
} from '@/data/mock/simulation';

// Demo Controls state (PRD DEMO-1): the mock bank's network conditions, kept
// across launches so a demo set up as "slow and flaky" stays that way. Money
// actions (fund wallet, time travel, reset) go through the demo repository; this
// store only holds settings.

export interface DemoState {
  simulation: SimulationSettings;
  setSimulation: (patch: Partial<SimulationSettings>) => void;
  resetSimulation: () => void;
}

const clampRate = (rate: number) => Math.min(1, Math.max(0, Number.isFinite(rate) ? rate : 0));

export const useDemoStore = create<DemoState>()(
  persist(
    (set) => ({
      simulation: DEFAULT_SIMULATION,
      setSimulation: (patch) =>
        set((s) => {
          const next = { ...s.simulation, ...patch };
          return { simulation: { ...next, errorRate: clampRate(next.errorRate) } };
        }),
      resetSimulation: () => set({ simulation: DEFAULT_SIMULATION }),
    }),
    {
      name: 'nem-demo',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ simulation: s.simulation }),
      merge: (persisted, current) => {
        const saved = (persisted as Partial<DemoState> | undefined)?.simulation;
        return { ...current, simulation: { ...DEFAULT_SIMULATION, ...saved } };
      },
    },
  ),
);

/**
 * Pushes the stored settings into the mock bank now and on every change.
 * Returns the unsubscribe function.
 */
export function bindSimulation(simulation: Simulation): () => void {
  simulation.set(useDemoStore.getState().simulation);
  return useDemoStore.subscribe((state, previous) => {
    if (state.simulation !== previous.simulation) simulation.set(state.simulation);
  });
}
