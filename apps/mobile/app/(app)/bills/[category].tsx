import { Redirect, useLocalSearchParams } from 'expo-router';

import { isBillCategory } from '@/features/bills/bills';
import { TopUpScreen } from '@/features/bills/screens/TopUpScreen';
import { UtilityScreen } from '@/features/bills/screens/UtilityScreen';

export default function BillCategoryRoute() {
  // `biller` and `customer` come from a saved biller.
  const { category, biller, customer } = useLocalSearchParams<{
    category: string;
    biller?: string;
    customer?: string;
  }>();
  if (!isBillCategory(category)) return <Redirect href="/bills" />;
  const prefill = { billerId: biller, customerId: customer };
  if (category === 'airtime' || category === 'data') {
    return <TopUpScreen category={category} prefill={prefill} />;
  }
  return <UtilityScreen category={category} prefill={prefill} />;
}
