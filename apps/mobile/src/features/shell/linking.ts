import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform } from 'react-native';

import { resolveDeepLink } from '@/lib/deepLinks';
import { useDeepLinkStore } from '@/stores';

/**
 * Opens a link from inside the app (a notification's `deep_link`, a scanned QR,
 * a shared pay link pasted in), routed the same way as one from outside.
 */
export function useOpenLink(): (url: string) => void {
  const router = useRouter();
  return useCallback((url: string) => router.push(resolveDeepLink(url).href), [router]);
}

/**
 * On web the router reads the address bar itself and native-intent never runs,
 * so a signed-out visit to /pay/abc is parked here before the auth gate
 * redirects it to the welcome screen.
 */
export function useParkWebEntryLink(signedIn: boolean): void {
  useState(() => {
    if (Platform.OS !== 'web' || signedIn || typeof window === 'undefined') return;
    const { pathname, search } = window.location;
    const { href, requiresAuth } = resolveDeepLink(`${pathname}${search}`);
    if (requiresAuth && pathname !== '/') useDeepLinkStore.getState().setPending(href);
  });
}
