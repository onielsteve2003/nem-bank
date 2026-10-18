import { hrefToPath, resolveDeepLink } from '@/lib/deepLinks';
import { useDeepLinkStore, useSessionStore } from '@/stores';

/** Waits for the session to be read from SecureStore, so a cold-start link knows which side of the gate it is on. */
function sessionStatus(): Promise<string> {
  const { status } = useSessionStore.getState();
  if (status !== 'restoring') return Promise.resolve(status);
  return new Promise((resolve) => {
    const unsubscribe = useSessionStore.subscribe((state) => {
      if (state.status === 'restoring') return;
      unsubscribe();
      resolve(state.status);
    });
  });
}

/**
 * Every link that opens the native app passes through here first (T4.5): custom
 * scheme, universal web links and Expo Go dev URLs are all rewritten to a route.
 * A signed-in route opened while signed out is parked until sign-in.
 */
export async function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    const { href, requiresAuth } = resolveDeepLink(path);
    if (requiresAuth && (await sessionStatus()) !== 'signedIn') {
      useDeepLinkStore.getState().setPending(href);
      return '/';
    }
    return hrefToPath(href);
  } catch {
    // A malformed link must never crash the app on launch.
    return '/';
  }
}
