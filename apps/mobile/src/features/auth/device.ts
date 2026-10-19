import type { Schema } from '@nem/contracts';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { DeviceKeyInfo } from '@/lib/deviceKey';

/**
 * What the bank shows in the devices list: "Ada's iPhone" at sign-up, or just
 * "iPhone" at login, before the app knows whose account it is.
 */
export function deviceName(firstName?: string): string {
  const kind = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'phone' : 'browser';
  if (firstName) return `${firstName}'s ${kind}`.slice(0, 60);
  return Platform.OS === 'ios'
    ? 'iPhone'
    : Platform.OS === 'android'
      ? 'Android phone'
      : 'Web browser';
}

export function devicePlatform(): Schema<'DeviceRegistration'>['platform'] {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
}

/** The public half of this device's key, as the bank registers it. */
export function deviceRegistration(
  key: DeviceKeyInfo,
  firstName?: string,
): Schema<'DeviceRegistration'> {
  return {
    name: deviceName(firstName),
    platform: devicePlatform(),
    public_key: key.publicKey,
    app_version: Constants.expoConfig?.version,
    hardware_backed: key.hardwareBacked,
  };
}
