import { UserSearch } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function SendRecipientRoute() {
  return (
    <PlaceholderScreen
      title="Recipient"
      icon={UserSearch}
      message="Look up a Nem user or a bank account and confirm the name."
      variant="stack"
    />
  );
}
