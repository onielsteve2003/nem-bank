import { LogIn } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function LogInRoute() {
  return (
    <PlaceholderScreen
      title="Log in"
      icon={LogIn}
      message="Sign in with your password, or with Face ID on this phone."
      variant="stack"
    />
  );
}
