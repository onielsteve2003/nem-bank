import { useLocalSearchParams } from 'expo-router';

import { GoalScreen } from '@/features/savings/screens/GoalScreen';

export default function GoalRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <GoalScreen id={id} />;
}
