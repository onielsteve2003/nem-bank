import { useLocalSearchParams } from 'expo-router';
import { UsersRound } from 'lucide-react-native';

import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';

export default function AjoInviteRoute() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return (
    <PlaceholderScreen
      title="Ajo invite"
      icon={UsersRound}
      message={`Invite ${code ?? ''} opens here: see the group, its schedule and payout order, then accept or decline.`}
      variant="modal"
    />
  );
}
