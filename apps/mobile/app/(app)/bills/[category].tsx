import { Redirect, useLocalSearchParams } from 'expo-router';

import { isBillCategory } from '@/features/bills/bills';
import { BillersScreen } from '@/features/bills/screens/BillersScreen';

export default function BillCategoryRoute() {
  const { category } = useLocalSearchParams<{ category: string }>();
  if (!isBillCategory(category)) return <Redirect href="/bills" />;
  return <BillersScreen category={category} />;
}
