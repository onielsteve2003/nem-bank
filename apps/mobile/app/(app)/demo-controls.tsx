import { SlidersHorizontal } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function DemoControlsRoute() {
  return (
    <PlaceholderScreen
      title="Demo Controls"
      icon={SlidersHorizontal}
      message="Fund your wallet, simulate incoming transfers, time-travel and reset the demo."
      variant="modal"
    />
  );
}
