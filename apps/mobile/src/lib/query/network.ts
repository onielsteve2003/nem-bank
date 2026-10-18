import NetInfo from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useSimulation } from '@/data';
import { isOnline, useNetworkStore } from '@/stores/network';

/**
 * Feeds the network store from the phone's connection and the mock bank's
 * offline switch, and tells TanStack Query, so reads pause offline and refetch
 * the moment the connection is back.
 */
export function useNetworkSync() {
  const simulation = useSimulation();

  useEffect(() => {
    // `isInternetReachable` is null until it has been checked: treat as online.
    return NetInfo.addEventListener((state) =>
      useNetworkStore
        .getState()
        .setDeviceOnline(state.isConnected !== false && state.isInternetReachable !== false),
    );
  }, []);

  useEffect(() => {
    if (!simulation) return;
    const sync = () => useNetworkStore.getState().setSimulatedOffline(simulation.get().offline);
    sync();
    return simulation.subscribe(sync);
  }, [simulation]);

  useEffect(() => {
    const sync = (s: Parameters<typeof isOnline>[0]) => onlineManager.setOnline(isOnline(s));
    sync(useNetworkStore.getState());
    return useNetworkStore.subscribe(sync);
  }, []);
}
