import type { Schema } from '@nem/contracts';
import { create } from 'zustand';

import {
  getPushPermission,
  requestPushPermission,
  type PushPermission,
  type PushSupport,
} from '@/lib/pushNotifications';
import i18n from '@/lib/i18n';

// Phone alerts for this device (NOT-3). Not persisted: the OS owns the
// permission, and the token is re-read and re-registered on every launch.

export interface PushState {
  /** `unknown` until the OS has been asked what it allows. */
  permission: PushPermission | 'unknown';
  /** The Expo push token the bank has for this device, once registered. */
  registeredToken: string | null;
}

export const usePushStore = create<PushState>()(() => ({
  permission: 'unknown',
  registeredToken: null,
}));

export async function refreshPushPermission(): Promise<PushPermission> {
  const permission = await getPushPermission();
  usePushStore.setState({ permission });
  return permission;
}

export async function askPushPermission(): Promise<PushPermission> {
  const permission = await requestPushPermission();
  usePushStore.setState({ permission });
  return permission;
}

/**
 * Whether the app raises the alert itself. The bank pushes only to a
 * registered token; the demo bank runs on the phone and has no push server.
 */
export function raisesLocally(apiMode: 'mock' | 'http', registeredToken: string | null): boolean {
  return apiMode === 'mock' || registeredToken === null;
}

/** An alert reaches the phone only if the customer wants push for its category. */
export function wantsPush(
  prefs: Schema<'NotificationPreferences'> | undefined,
  category: Schema<'NotificationCategory'>,
): boolean {
  return prefs?.categories[category].push ?? false;
}

export type PhoneAlertStatus = {
  tone: 'success' | 'warning' | 'info';
  title: string;
  detail: string;
  action: 'enable' | 'settings' | 'test' | null;
};

/** What the settings screen says about this phone, in words. */
export function phoneAlertStatus(
  support: PushSupport,
  permission: PushState['permission'],
): PhoneAlertStatus {
  if (support === 'none') {
    return {
      tone: 'info',
      title: i18n.t('notifications.phone.none.title'),
      detail: i18n.t('notifications.phone.none.detail'),
      action: null,
    };
  }
  if (permission === 'denied') {
    return {
      tone: 'warning',
      title: i18n.t('notifications.phone.denied.title'),
      detail: i18n.t('notifications.phone.denied.detail'),
      action: 'settings',
    };
  }
  if (permission !== 'granted') {
    return {
      tone: 'info',
      title: i18n.t('notifications.phone.ask.title'),
      detail: i18n.t('notifications.phone.ask.detail'),
      action: 'enable',
    };
  }
  return support === 'push'
    ? {
        tone: 'success',
        title: i18n.t('notifications.phone.push.title'),
        detail: i18n.t('notifications.phone.push.detail'),
        action: 'test',
      }
    : {
        tone: 'success',
        title: i18n.t('notifications.phone.local.title'),
        detail: i18n.t('notifications.phone.local.detail'),
        action: 'test',
      };
}
