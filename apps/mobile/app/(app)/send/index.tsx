import { Send } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function SendMoneyRoute() {
  return (
    <PlaceholderScreen
      title="Send money"
      icon={Send}
      message="Choose who to pay, enter an amount and confirm with your PIN."
      variant="modal"
    />
  );
}
