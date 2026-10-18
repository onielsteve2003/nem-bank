import { useLocalSearchParams } from 'expo-router';
import { QrCode } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function QrPayRoute() {
  const { payload } = useLocalSearchParams<{ payload?: string }>();
  return (
    <PlaceholderScreen
      title="Pay by QR"
      icon={QrCode}
      message={
        payload
          ? 'This code is checked with the bank, then you see who you are paying before you confirm.'
          : 'Scan a Nem QR code to pay.'
      }
      variant="modal"
    />
  );
}
