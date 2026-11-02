import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useRealtime } from '@/data';
import { resolveDeepLink } from '@/lib/deepLinks';
import { env } from '@/lib/env';
import {
  configureAlerts,
  getPushSupport,
  getPushToken,
  onAlertOpened,
  showLocalAlert,
} from '@/lib/pushNotifications';
import { queryKeys, useRepoMutation, useRepoQuery, type OutputOf } from '@/lib/query';
import { useSessionStore } from '@/stores';

import { raisesLocally, refreshPushPermission, usePushStore, wantsPush } from '../push';

/**
 * Connects the signed-in app to phone alerts (NOT-3): registers this phone's
 * Expo push token with the bank once alerts are allowed, raises a local alert
 * for each new notification when no server push will arrive, and opens the
 * screen an alert is about when it is tapped. Renders nothing.
 */
export function PushBridge() {
  const router = useRouter();
  const realtime = useRealtime();
  const deviceId = useSessionStore((s) => s.session?.deviceId);
  const permission = usePushStore((s) => s.permission);
  const client = useQueryClient();
  // Loaded here so each alert can check its category's push switch.
  useRepoQuery('notifications', 'getPreferences');
  const register = useRepoMutation('notifications', 'registerPushToken', { invalidates: [] });
  const markRead = useRepoMutation('notifications', 'markRead');

  // The permission can change in phone settings while Nem is in the background.
  useEffect(() => {
    configureAlerts();
    void refreshPushPermission();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshPushPermission();
    });
    return () => sub.remove();
  }, []);

  const { mutate: registerToken } = register;
  useEffect(() => {
    if (permission !== 'granted' || !deviceId || getPushSupport() !== 'push') return;
    let live = true;
    void getPushToken().then((token) => {
      if (!live || !token || token === usePushStore.getState().registeredToken) return;
      registerToken(
        { body: { device_id: deviceId, expo_push_token: token } },
        { onSuccess: () => usePushStore.setState({ registeredToken: token }) },
      );
    });
    return () => {
      live = false;
    };
  }, [permission, deviceId, registerToken]);

  useEffect(
    () =>
      realtime.subscribe((event) => {
        if (event.type !== 'notification.created') return;
        const { permission: allowed, registeredToken } = usePushStore.getState();
        if (allowed !== 'granted' || !raisesLocally(env.apiMode, registeredToken)) return;
        const n = event.data;
        const prefs = client.getQueryData<OutputOf<'notifications', 'getPreferences'>>(
          queryKeys.op('notifications', 'getPreferences'),
        );
        if (!wantsPush(prefs, n.category)) return;
        void showLocalAlert({ id: n.id, title: n.title, body: n.body, deepLink: n.deep_link });
      }),
    [realtime, client],
  );

  const { mutate: markAsRead } = markRead;
  useEffect(
    () =>
      onAlertOpened(({ id, deepLink }) => {
        if (id) markAsRead({ body: { ids: [id] } });
        if (deepLink) router.push(resolveDeepLink(deepLink).href);
      }),
    [router, markAsRead],
  );

  return null;
}
