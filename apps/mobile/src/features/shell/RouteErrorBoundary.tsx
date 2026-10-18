import { useRouter, type ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';

import { CrashScreen, reportCrash } from './CrashScreen';

/** Expo Router renders this in place of a route that threw (exported from layouts). */
export function RouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const router = useRouter();
  useEffect(() => reportCrash(error), [error]);
  return <CrashScreen error={error} retry={retry} onHome={() => router.replace('/')} />;
}
