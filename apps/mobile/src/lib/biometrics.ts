import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

// Face ID / fingerprint (AUTH-5). Web has none and gets the PIN only (biometrics.web.ts).

export interface Biometrics {
  available: boolean;
  /** What the user calls it: "Face ID", "Touch ID", "fingerprint". */
  label: string;
}

export const NO_BIOMETRICS: Biometrics = { available: false, label: '' };

const { AuthenticationType } = LocalAuthentication;

/** Available only with hardware *and* something enrolled; never throws. */
export async function getBiometrics(): Promise<Biometrics> {
  try {
    const [hardware, enrolled, types] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    if (!hardware || !enrolled) return NO_BIOMETRICS;
    const face = types.includes(AuthenticationType.FACIAL_RECOGNITION);
    const ios = Platform.OS === 'ios';
    const label = face ? (ios ? 'Face ID' : 'face unlock') : ios ? 'Touch ID' : 'fingerprint';
    return { available: true, label };
  } catch {
    return NO_BIOMETRICS;
  }
}

/**
 * The device passcode fallback is off: the app's own PIN is the fallback, so a
 * shoulder-surfed phone passcode cannot open the bank.
 */
export async function authenticateWithBiometrics(promptMessage: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: 'Use PIN',
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}
