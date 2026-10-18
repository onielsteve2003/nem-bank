import { BadgeCheck } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function VerifyIdentityRoute() {
  return (
    <PlaceholderScreen
      title="Verify identity"
      icon={BadgeCheck}
      message="Confirm your BVN, NIN and a selfie to raise your limits."
      variant="modal"
    />
  );
}
