import { KeyRound } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function CreatePasswordRoute() {
  return (
    <PlaceholderScreen
      title="Create a password"
      icon={KeyRound}
      message="Choose a password and a 4-digit transaction PIN."
      variant="stack"
    />
  );
}
