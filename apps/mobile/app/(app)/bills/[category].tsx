import { Redirect, useLocalSearchParams } from 'expo-router';

import { isBillCategory } from '@/features/bills/bills';
import { BillersScreen } from '@/features/bills/screens/BillersScreen';
import { TopUpScreen } from '@/features/bills/screens/TopUpScreen';

export default function BillCategoryRoute() {
  const { category } = useLocalSearchParams<{ category: string }>();
  if (!isBillCategory(category)) return <Redirect href="/bills" />;
  if (category === 'airtime' || category === 'data') return <TopUpScreen category={category} />;
  return <BillersScreen category={category} />;
}
