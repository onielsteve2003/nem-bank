import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { getBiometrics } from './biometrics';

jest.mock('expo-local-authentication', () => ({
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2 },
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  supportedAuthenticationTypesAsync: jest.fn(async () => [2]),
}));

const runIn = (environment: ExecutionEnvironment) =>
  Object.defineProperty(Constants, 'executionEnvironment', {
    value: environment,
    configurable: true,
  });

beforeEach(() => {
  Platform.OS = 'ios';
});

it('turns Face ID off inside Expo Go, which cannot use it, and says why', async () => {
  runIn(ExecutionEnvironment.StoreClient);
  await expect(getBiometrics()).resolves.toEqual({
    available: false,
    label: 'Face ID',
    blockedBy: 'expoGo',
  });
});

it('offers Face ID in the installed app', async () => {
  runIn(ExecutionEnvironment.Standalone);
  await expect(getBiometrics()).resolves.toEqual({ available: true, label: 'Face ID' });
});

it('keeps Touch ID in Expo Go, which needs no permission text', async () => {
  runIn(ExecutionEnvironment.StoreClient);
  jest.mocked(LocalAuthentication.supportedAuthenticationTypesAsync).mockResolvedValueOnce([1]);
  await expect(getBiometrics()).resolves.toEqual({ available: true, label: 'Touch ID' });
});
