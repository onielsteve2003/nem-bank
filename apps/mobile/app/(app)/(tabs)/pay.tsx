import { ArrowLeftRight } from 'lucide-react-native';
import { useRouter } from 'expo-router';

import { Button } from '@/components';
import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function PayRoute() {
  const router = useRouter();
  return (
    <PlaceholderScreen
      title="Pay"
      icon={ArrowLeftRight}
      message="Send to Nem users and banks, pay bills, request money and scan QR codes."
      variant="tab"
    >
      <Button label="Send money" onPress={() => router.push('/send')} />
      <Button label="Requests" variant="secondary" onPress={() => router.push('/send/requests')} />
      <Button
        label="Split a bill"
        variant="secondary"
        onPress={() => router.push('/send/splits')}
      />
      <Button
        label="Payment links"
        variant="secondary"
        onPress={() => router.push('/send/links')}
      />
      <Button
        label="Scheduled payments"
        variant="secondary"
        onPress={() => router.push('/send/scheduled')}
      />
    </PlaceholderScreen>
  );
}
