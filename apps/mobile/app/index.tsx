import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';

import { useDeepLinkStore, useSessionStore } from '@/stores';

// The entry point. A restored session opens on Home, or on the link that was
// waiting for sign-in (T4.5); otherwise the welcome screen.
export default function Index() {
  const signedIn = useSessionStore((s) => s.status === 'signedIn');
  // Read once: clearing the store below must not re-run this redirect.
  const [pending] = useState(() => (signedIn ? useDeepLinkStore.getState().pending : null));

  useEffect(() => {
    if (pending) useDeepLinkStore.getState().setPending(null);
  }, [pending]);

  if (!signedIn) return <Redirect href="/welcome" />;
  return <Redirect href={pending ?? '/home'} />;
}
