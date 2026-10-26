import { useLocalSearchParams } from 'expo-router';

import { BillReceiptScreen } from '@/features/bills/screens/BillReceiptScreen';

export default function BillReceiptRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <BillReceiptScreen id={id} />;
}
