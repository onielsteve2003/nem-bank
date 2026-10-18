import { useRouter } from 'expo-router';
import { SlidersHorizontal, X } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  DemoMoneyBadge,
  EmptyState,
  ErrorState,
  IconButton,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
} from '@/components';
import { useSimulation } from '@/data';
import { useRepoQuery } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { MoneySection } from '../components/MoneySection';
import { NetworkSection } from '../components/NetworkSection';
import { ResetSection } from '../components/ResetSection';
import { ScenarioSection } from '../components/ScenarioSection';

/**
 * Demo Controls (PRD DEMO-1): the levers that let anyone, a recruiter on the web
 * demo included, see the whole bank work without real money or a real outage.
 */
export function DemoControlsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const isDemo = useSessionStore((s) => s.session?.isDemo ?? false);
  // Only the mock bank has a network to simulate; the real API has no such switch.
  const simulation = useSimulation();
  const accounts = useRepoQuery('accounts', 'list', undefined, { enabled: isDemo });

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4], paddingTop: spacing[2] }]}>
      <View style={[styles.title, { gap: spacing[1] }]}>
        <Text variant="h2">Demo Controls</Text>
        <DemoMoneyBadge />
      </View>
      <IconButton
        icon={X}
        accessibilityLabel="Close"
        variant="ghost"
        onPress={() => router.back()}
      />
    </View>
  );

  if (!isDemo) {
    return (
      <Screen header={header}>
        <EmptyState
          icon={SlidersHorizontal}
          title="Only for the demo account"
          message="Demo Controls move simulated money. Sign in with “Try the demo” to use them."
        />
      </Screen>
    );
  }

  let money;
  if (accounts.isPending) {
    money = (
      <SkeletonGroup accessibilityLabel="Loading wallets">
        <SkeletonListItem />
        <SkeletonListItem />
      </SkeletonGroup>
    );
  } else if (accounts.isError) {
    money = (
      <ErrorState message="We couldn’t load your wallets." onRetry={() => accounts.refetch()} />
    );
  } else {
    money = <MoneySection accounts={accounts.data.data} />;
  }

  return (
    <Screen header={header}>
      {money}
      <ScenarioSection />
      {simulation && <NetworkSection />}
      <ResetSection />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', minHeight: 44 },
  title: { flex: 1, alignItems: 'flex-start' },
});
