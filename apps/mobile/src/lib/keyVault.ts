import * as SecureStore from 'expo-secure-store';

// Where the device's private key lives: the iOS Keychain / Android Keystore. With
// `biometric`, reading it needs Face ID or a fingerprint, enforced by the OS rather
// than by app code. Web has no such store (keyVault.web.ts).

/** False only on the web demo, where the key sits in tab memory (DeviceRegistration.hardware_backed). */
export const KEY_IS_HARDWARE_BACKED = true;

/** Never synced to iCloud or another phone: a restored backup must bind as a new device. */
const accessible = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

export async function saveSecret(key: string, value: string, biometric: boolean): Promise<void> {
  await SecureStore.setItemAsync(key, value, {
    requireAuthentication: biometric,
    keychainAccessible: accessible,
  });
}

/** Shows the system Face ID / fingerprint sheet first when the secret is biometric-bound. */
export async function readSecret(
  key: string,
  biometric: boolean,
  prompt: string,
): Promise<string | null> {
  return SecureStore.getItemAsync(key, {
    requireAuthentication: biometric,
    authenticationPrompt: prompt,
    keychainAccessible: accessible,
  });
}

export async function deleteSecret(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key, { keychainAccessible: accessible });
}
