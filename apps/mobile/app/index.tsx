import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';

import { useDeepLinkStore, useSessionStore } from '@/stores';

// The entry point. A restored session opens on Home, or on the link that was
// waiting for sign-in (T4.5); otherwise the welcome screen. A new account
// without an @nemtag chooses one first; a waiting link keeps until after.
export default function Index() {
  const signedIn = useSessionStore((s) => s.status === 'signedIn');
  const needsNemtag = useSessionStore((s) => s.session?.needsNemtag === true);
  // Read once: clearing the store below must not re-run this redirect.
  const [pending] = useState(() =>
    signedIn && !needsNemtag ? useDeepLinkStore.getState().pending : null,
  );

  useEffect(() => {
    if (pending) useDeepLinkStore.getState().setPending(null);
  }, [pending]);

  if (!signedIn) return <Redirect href="/welcome" />;
  if (needsNemtag) return <Redirect href="/choose-nemtag" />;
  return <Redirect href={pending ?? '/home'} />;
}
