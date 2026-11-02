import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';

// Phone alerts (NOT-3). A server push needs an Expo push token; Expo Go on
// Android lost remote push in SDK 53, so there the app raises the alert itself
// (a local notification), which Expo Go still supports everywhere.

/** `push`: the bank can reach this phone. `localOnly`: only the app can raise alerts. */
export type PushSupport = 'push' | 'localOnly' | 'none';
export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** `id` is the inbox notification, so opening the alert can mark it read. */
export type LocalAlert = { id: string; title: string; body: string; deepLink: string | null };
export type OpenedAlert = { id: string | null; deepLink: string | null };

export function getPushSupport(): PushSupport {
  const expoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  return expoGo && Platform.OS === 'android' ? 'localOnly' : 'push';
}

const permissionOf = (p: Notifications.NotificationPermissionsStatus): PushPermission =>
  p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';

export async function getPushPermission(): Promise<PushPermission> {
  try {
    return permissionOf(await Notifications.getPermissionsAsync());
  } catch {
    return 'denied';
  }
}

export async function requestPushPermission(): Promise<PushPermission> {
  try {
    return permissionOf(await Notifications.requestPermissionsAsync());
  } catch {
    return 'denied';
  }
}

/** The Expo push token, or null on a simulator, offline, or without push. Never throws. */
export async function getPushToken(): Promise<string | null> {
  if (getPushSupport() !== 'push') return null;
  try {
    const projectId = (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)
      ?.projectId;
    const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : {});
    return data;
  } catch {
    return null;
  }
}

let configured = false;

/** Alerts that arrive while Nem is open still show as a banner. */
export function configureAlerts(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('default', {
      name: 'Alerts',
      importance: AndroidImportance.HIGH,
    }).catch(() => undefined);
  }
}

export async function showLocalAlert({ id, title, body, deepLink }: LocalAlert): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { id, deep_link: deepLink } },
      trigger: null,
    });
  } catch {
    // An alert that cannot show is still in the inbox.
  }
}

/**
 * Calls back with an alert the customer tapped, including the one that
 * launched the app. Server pushes carry the same `id` and `deep_link` data.
 * Returns the unsubscribe function.
 */
export function onAlertOpened(open: (alert: OpenedAlert) => void): () => void {
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const linkOf = (r: Notifications.NotificationResponse): OpenedAlert => {
    const data = r.notification.request.content.data ?? {};
    return { id: text(data.id), deepLink: text(data.deep_link) };
  };
  const sub = Notifications.addNotificationResponseReceivedListener((r) => open(linkOf(r)));
  const last = Notifications.getLastNotificationResponse();
  if (last) {
    // Cleared so a later remount does not open the same alert again.
    Notifications.clearLastNotificationResponse();
    open(linkOf(last));
  }
  return () => sub.remove();
}
