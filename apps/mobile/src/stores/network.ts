import { create } from 'zustand';

// Whether the app can reach the bank, and why not. The phone's own connection
// (NetInfo) and the mock bank's simulated outage (Demo Controls) are kept apart
// so the offline banner can say which one it is.

export interface NetworkState {
  /** The device has a connection that reaches the internet. Unknown counts as online. */
  deviceOnline: boolean;
  /** Demo Controls has switched the mock bank offline. */
  simulatedOffline: boolean;
  /** When the app last had a connection; the banner says how old the saved data is. */
  lastOnlineAt: number;
  setDeviceOnline: (online: boolean) => void;
  setSimulatedOffline: (offline: boolean) => void;
}

export const useNetworkStore = create<NetworkState>()((set, get) => ({
  deviceOnline: true,
  simulatedOffline: false,
  lastOnlineAt: Date.now(),
  setDeviceOnline: (deviceOnline) => set(next(get(), { deviceOnline })),
  setSimulatedOffline: (simulatedOffline) => set(next(get(), { simulatedOffline })),
}));

function next(state: NetworkState, patch: Partial<NetworkState>): Partial<NetworkState> {
  // Stamp the moment the connection went away, not every update while it is gone.
  const wasOnline = isOnline(state);
  return wasOnline ? { ...patch, lastOnlineAt: Date.now() } : patch;
}

export const isOnline = (s: Pick<NetworkState, 'deviceOnline' | 'simulatedOffline'>) =>
  s.deviceOnline && !s.simulatedOffline;

export const useIsOnline = () => useNetworkStore(isOnline);
