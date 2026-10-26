import { useLocalSearchParams } from 'expo-router';

import { AjoInviteScreen } from '@/features/ajo/screens/AjoInviteScreen';

export default function AjoInviteRoute() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <AjoInviteScreen code={(code ?? '').toUpperCase()} />;
}
