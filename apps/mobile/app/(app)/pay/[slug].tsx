import { useLocalSearchParams } from 'expo-router';
import { Link2 } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function PaymentLinkRoute() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  return (
    <PlaceholderScreen
      title="Pay link"
      icon={Link2}
      message={`Payment link ${slug ?? ''} opens here: see who you are paying, the amount, then confirm with your PIN.`}
      variant="modal"
    />
  );
}
