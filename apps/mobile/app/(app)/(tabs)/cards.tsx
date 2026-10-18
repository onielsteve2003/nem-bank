import { CreditCard } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function CardsRoute() {
  return (
    <PlaceholderScreen
      title="Cards"
      icon={CreditCard}
      message="Virtual cards you can freeze, limit and control in one tap."
      variant="tab"
    />
  );
}
