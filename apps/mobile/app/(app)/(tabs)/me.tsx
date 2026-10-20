import { useRouter } from 'expo-router';
import {
  BadgeCheck,
  CircleUser,
  FileText,
  LayoutGrid,
  LogOut,
  SlidersHorizontal,
} from 'lucide-react-native';

import { Card, ListItem } from '@/components';
import { useSignOut } from '@/features/auth/hooks/useSessionActions';
import { PlaceholderScreen } from '@/features/shell/PlaceholderScreen';
import { devToolsEnabled } from '@/lib/env';

export default function MeRoute() {
  const router = useRouter();
  const signOut = useSignOut();
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
          title="Statements"
          subtitle="Official PDFs with a verification code"
          leading={FileText}
          onPress={() => router.push('/statements')}
        />
        <ListItem
          title="Demo Controls"
          subtitle="Fund the wallet, simulate transfers, reset"
          leading={SlidersHorizontal}
          onPress={() => router.push('/demo-controls')}
        />
        {devToolsEnabled && (
          <ListItem
            title="Design system"
            subtitle="Every Volt Noir component"
            leading={LayoutGrid}
            onPress={() => router.push('/kit')}
          />
        )}
        <ListItem
          title="Sign out"
          subtitle="Back to the welcome screen"
          leading={LogOut}
          onPress={() => void signOut()}
        />
      </Card>
    </PlaceholderScreen>
  );
}
