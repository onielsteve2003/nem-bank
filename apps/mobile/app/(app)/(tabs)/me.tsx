import { useRouter } from 'expo-router';
import { BadgeCheck, CircleUser, LayoutGrid, LogIn, SlidersHorizontal } from 'lucide-react-native';

import { Card, ListItem } from '@/components';
import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';
import { devToolsEnabled } from '@/lib/env';

export default function MeRoute() {
  const router = useRouter();
  return (
    <PlaceholderScreen
      title="Me"
      icon={CircleUser}
      message="Your profile, security, settings and help."
    >
      <Card padded={false}>
        <ListItem
          title="Verify your identity"
          subtitle="Raise your limits"
          leading={BadgeCheck}
          onPress={() => router.push('/kyc')}
        />
        <ListItem
          title="Demo Controls"
          subtitle="Fund the wallet, simulate transfers, reset"
          leading={SlidersHorizontal}
          onPress={() => router.push('/demo-controls')}
        />
        <ListItem
          title="Welcome screens"
          subtitle="Preview the signed-out flow"
          leading={LogIn}
          onPress={() => router.push('/welcome')}
        />
        {devToolsEnabled && (
          <ListItem
            title="Design system"
            subtitle="Every Volt Noir component"
            leading={LayoutGrid}
            onPress={() => router.push('/kit')}
          />
        )}
      </Card>
    </PlaceholderScreen>
  );
}
