import { Sparkles } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function AssistantRoute() {
  return (
    <PlaceholderScreen
      title="Nem Assistant"
      icon={Sparkles}
      message="Ask about your spending, or say “Send 5k to Mum for food” and check the payment it prepares before you confirm it."
      variant="modal"
    />
  );
}
