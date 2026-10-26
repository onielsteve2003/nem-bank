import { useLocalSearchParams } from 'expo-router';

import { LoanScreen } from '@/features/credit/screens/LoanScreen';

export default function LoanRoute() {
  const { id, new: justBorrowed } = useLocalSearchParams<{ id: string; new?: string }>();
  return <LoanScreen id={id} justBorrowed={justBorrowed === '1'} />;
}
