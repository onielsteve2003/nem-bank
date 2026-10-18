import * as SecureStore from 'expo-secure-store';
import type { StateStorage } from 'zustand/middleware';

// Tokens and other secrets live in the Keychain / Keystore, never in AsyncStorage
// (architecture §3). Values stay small: iOS warns above 2 KB per key.

export const secureStorage: StateStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};
