import { Redirect, useLocalSearchParams } from 'expo-router';

import { isBillCategory } from '@/features/bills/bills';
import { TopUpScreen } from '@/features/bills/screens/TopUpScreen';
import { UtilityScreen } from '@/features/bills/screens/UtilityScreen';

export default function BillCategoryRoute() {
  const { category } = useLocalSearchParams<{ category: string }>();
  if (!isBillCategory(category)) return <Redirect href="/bills" />;
  if (category === 'airtime' || category === 'data') return <TopUpScreen category={category} />;
  return <UtilityScreen category={category} />;
}
