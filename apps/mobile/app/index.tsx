import { Redirect } from 'expo-router';

import { useSessionStore } from '@/stores';

// The entry point. A restored session opens on Home; otherwise the welcome screen.
export default function Index() {
  const signedIn = useSessionStore((s) => s.status === 'signedIn');
  return <Redirect href={signedIn ? '/home' : '/welcome'} />;
}
