import { Redirect } from 'expo-router';

import { KitScreen } from '@/features/kit/KitScreen';
import { devToolsEnabled } from '@/lib/env';

// Dev tool: builds wired to the real API send a typed-in /kit URL home.
export default function KitRoute() {
  return devToolsEnabled ? <KitScreen /> : <Redirect href="/" />;
}
