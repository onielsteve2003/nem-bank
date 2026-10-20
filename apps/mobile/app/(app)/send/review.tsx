import { ShieldCheck } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function SendReviewRoute() {
  return (
    <PlaceholderScreen
      title="Review"
      icon={ShieldCheck}
      message="Check the details and confirm with your PIN or Face ID."
      variant="stack"
    />
  );
}
