import type { LocalAlert, OpenedAlert, PushPermission, PushSupport } from './pushNotifications';

export type { LocalAlert, OpenedAlert, PushPermission, PushSupport } from './pushNotifications';

// Expo push does not reach browsers, so the web demo keeps every alert in the
// inbox and never asks for permission.

export const getPushSupport = (): PushSupport => 'none';
export const getPushPermission = async (): Promise<PushPermission> => 'denied';
export const requestPushPermission = async (): Promise<PushPermission> => 'denied';
export const getPushToken = async (): Promise<string | null> => null;
export const configureAlerts = (): void => undefined;
export const showLocalAlert = async (_alert: LocalAlert): Promise<void> => undefined;
export const onAlertOpened =
  (_open: (alert: OpenedAlert) => void): (() => void) =>
  () =>
    undefined;
