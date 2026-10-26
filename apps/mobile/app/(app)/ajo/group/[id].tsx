import { useLocalSearchParams } from 'expo-router';

import { AjoGroupScreen } from '@/features/ajo/screens/AjoGroupScreen';

export default function AjoGroupRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AjoGroupScreen id={id} />;
}
