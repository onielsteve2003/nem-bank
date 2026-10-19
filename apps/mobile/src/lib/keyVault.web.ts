import { secureStorage } from './secureStorage';

// Browsers have no keychain the app can bind to biometrics. The web demo keeps the
// device key where it keeps tokens (sessionStorage, dying with the tab) and tells
// the bank it is not hardware-backed, so the server can treat it with less trust.

export const KEY_IS_HARDWARE_BACKED = false;

export async function saveSecret(key: string, value: string): Promise<void> {
  await secureStorage.setItem(key, value);
}

export async function readSecret(key: string): Promise<string | null> {
  return (await secureStorage.getItem(key)) ?? null;
}

export async function deleteSecret(key: string): Promise<void> {
  await secureStorage.removeItem(key);
}
