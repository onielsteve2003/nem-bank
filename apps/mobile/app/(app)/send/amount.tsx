import { Banknote } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function SendAmountRoute() {
  return (
    <PlaceholderScreen
      title="Amount"
      icon={Banknote}
      message="Enter how much to send and see the fee before you confirm."
      variant="stack"
    />
  );
}
