import { Flag } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function NewDisputeRoute() {
  return (
    <PlaceholderScreen
      title="Report a problem"
      icon={Flag}
      message="Tell us what went wrong with this payment, add evidence and track the dispute here."
      variant="modal"
    />
  );
}
