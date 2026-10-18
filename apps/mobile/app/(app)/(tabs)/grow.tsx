import { Sprout } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function GrowRoute() {
  return (
    <PlaceholderScreen
      title="Grow"
      icon={Sprout}
      message="Savings goals, ajo circles, credit and insights into your spending."
      variant="tab"
    />
  );
}
