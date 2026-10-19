import { ScanFace } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function EnableBiometricsRoute() {
  return (
    <PlaceholderScreen
      title="Use Face ID"
      icon={ScanFace}
      message="Approve payments and unlock the app with Face ID or your fingerprint."
      variant="stack"
    />
  );
}
