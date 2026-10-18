import { UserPlus } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function SignUpRoute() {
  return (
    <PlaceholderScreen
      title="Sign up"
      icon={UserPlus}
      message="Open an account in a few minutes with your email and phone number."
      variant="stack"
    />
  );
}
