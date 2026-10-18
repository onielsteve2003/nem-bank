import { House } from 'lucide-react-native';
import { useRouter } from 'expo-router';

import { Button } from '@/components';
import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function HomeRoute() {
  const router = useRouter();
  return (
    <PlaceholderScreen
      title="Home"
      icon={House}
      message="Your balances in every currency, quick actions and recent activity will live here."
      variant="tab"
    >
      <Button label="Send money" onPress={() => router.push('/send')} />
      <Button label="Convert" variant="secondary" onPress={() => router.push('/convert')} />
    </PlaceholderScreen>
  );
}
