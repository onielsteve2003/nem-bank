/* global jest */
// Reanimated 4 loads react-native-worklets, whose native module does not exist in
// Jest; its bundled mock runs worklets synchronously on the JS thread instead.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
// Gesture handler's own Jest setup: modal flows mount a GestureHandlerRootView (ModalSheetHost).
require('react-native-gesture-handler/jestSetup');
// @gorhom/bottom-sheet needs a native gesture root; its bundled mock renders sheet content inline.
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
// AsyncStorage's bundled in-memory mock (TanStack Query cache persistence).
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
// NetInfo's bundled mock reports a connected device.
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock'),
);
// expo-crypto's native random source is missing in Jest; Node's CSPRNG stands in.
jest.mock('expo-crypto', () => ({
  getRandomBytes: (count) => Uint8Array.from(require('crypto').randomBytes(count)),
}));
// SecureStore has no native module in Jest; an in-memory Keychain stands in.
jest.mock('expo-secure-store', () => {
  const items = new Map();
  return {
    getItemAsync: jest.fn(async (key) => items.get(key) ?? null),
    setItemAsync: jest.fn(async (key, value) => void items.set(key, value)),
    deleteItemAsync: jest.fn(async (key) => void items.delete(key)),
  };
});
// expo-notifications' native module is missing in Jest: no permission, no taps, no token.
jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: false })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[test]' })),
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
}));
// Strings come from the English catalogue (SET-2), so tests read what users read.
require('./src/lib/i18n');
