import { ArrowLeftRight } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function ConvertRoute() {
  return (
    <PlaceholderScreen
      title="Convert"
      icon={ArrowLeftRight}
      message="Swap between NGN, USD, GBP and EUR with a live quote locked for 60 seconds."
      variant="modal"
    />
  );
}
