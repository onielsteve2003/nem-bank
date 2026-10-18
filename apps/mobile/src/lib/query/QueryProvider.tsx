import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import {
  focusManager,
  onlineManager,
  QueryClientProvider,
  type QueryClient,
} from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import Constants from 'expo-constants';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';

import { useSimulation } from '@/data';

import { createQueryClient, PERSIST_MAX_AGE_MS, shouldPersistQuery } from './client';
import { useRealtimeSync } from './realtime';

/** Bump to drop every persisted cache after a breaking change to cached shapes. */
const CACHE_VERSION = 1;
const CACHE_KEY = 'nem-query-cache';

export interface Props {
  children: ReactNode;
  /** Tests inject a client (and skip persistence). */
  client?: QueryClient;
}

function RealtimeSync() {
  useRealtimeSync();
  return null;
}

/** "Online" follows the mock bank's offline switch, so queries pause and resume with it. */
function useOnlineFromSimulation() {
  const simulation = useSimulation();
  useEffect(() => {
    if (!simulation) return;
    const sync = () => onlineManager.setOnline(!simulation.get().offline);
    sync();
    return simulation.subscribe(sync);
  }, [simulation]);
}

/** On native, "focus" is the app coming to the foreground (the web uses the tab). */
function useAppFocus() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (state) =>
      focusManager.setFocused(state === 'active'),
    );
    return () => sub.remove();
  }, []);
}

/**
 * Server state for the app: TanStack Query with a persisted cache (offline reads),
 * realtime updates and the retry rules in ./client.
 */
export function QueryProvider({ children, client: injected }: Props) {
  const [client] = useState(() => injected ?? createQueryClient());
  const [persister] = useState(() =>
    createAsyncStoragePersister({ storage: AsyncStorage, key: CACHE_KEY, throttleTime: 1_000 }),
  );
  useOnlineFromSimulation();
  useAppFocus();

  if (injected) {
    return (
      <QueryClientProvider client={client}>
        <RealtimeSync />
        {children}
      </QueryClientProvider>
    );
  }
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE_MS,
        buster: `${Constants.expoConfig?.version ?? '0'}:${CACHE_VERSION}`,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
    >
      <RealtimeSync />
      {children}
    </PersistQueryClientProvider>
  );
}
