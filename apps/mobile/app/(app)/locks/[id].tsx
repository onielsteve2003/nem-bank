import { useLocalSearchParams } from 'expo-router';

import { LockScreen } from '@/features/savings/screens/LockScreen';

export default function LockRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <LockScreen id={id} />;
}
