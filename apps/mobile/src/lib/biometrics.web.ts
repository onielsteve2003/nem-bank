// Browsers have no Face ID or fingerprint API the app can use, so the web demo
// unlocks with the PIN only.

import type { Biometrics } from './biometrics';

export type { Biometrics } from './biometrics';

export const NO_BIOMETRICS: Biometrics = { available: false, label: '' };

export async function getBiometrics(): Promise<Biometrics> {
  return NO_BIOMETRICS;
}

export async function authenticateWithBiometrics(): Promise<boolean> {
  return false;
}
