import { Redirect } from 'expo-router';

// The entry point. The auth gate (T4.2) decides between welcome and home; until
// then the app opens on Home.
export default function Index() {
  return <Redirect href="/home" />;
}
