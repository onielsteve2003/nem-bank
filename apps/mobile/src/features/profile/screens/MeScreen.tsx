import { useRouter } from 'expo-router';
import {
  BadgeCheck,
  FileText,
  Gauge,
  LayoutGrid,
  LogOut,
  MonitorSmartphone,
  OctagonX,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  Divider,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { useSignOut } from '@/features/auth/hooks/useSessionActions';
import { devToolsEnabled } from '@/lib/env';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

/** The Me tab: who you are, your security, documents and app tools. */
export function MeScreen() {
  const router = useRouter();
  const signOut = useSignOut();
  const { spacing } = useTheme();
  const me = useRepoQuery('users', 'getMe');
  const checkup = useRepoQuery('security', 'getCheckup');
  const panic = useRepoQuery('security', 'getPanic');
  const user = me.data;
  const name = user ? (user.preferred_name ?? `${user.first_name} ${user.last_name}`) : '';

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4] }]}>
      <Text variant="title" accessibilityRole="header">
        Me
      </Text>
    </View>
  );

  return (
    <Screen
      header={header}
      edges={['top']}
      onRefresh={() => void Promise.all([me.refetch(), checkup.refetch(), panic.refetch()])}
      refreshing={me.isRefetching}
    >
      <Card>
        {user ? (
          <View style={[styles.row, { gap: spacing[4] }]}>
            <Avatar name={name} uri={user.avatar_url ?? undefined} size="lg" ring />
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="h3">{name}</Text>
              {user.nemtag && (
                <Text variant="bodySmall" color="textMuted">
                  {`@${user.nemtag}`}
                </Text>
              )}
              <View style={styles.start}>
                <Badge label={`KYC Tier ${user.kyc_tier}`} tone="primary" />
              </View>
            </View>
          </View>
        ) : (
          <SkeletonGroup accessibilityLabel="Loading your profile">
            <Skeleton height={72} />
          </SkeletonGroup>
        )}
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Security" />
        <Card padded={false}>
          <ListItem
            title="Security center"
            subtitle={
              checkup.data
                ? `Checkup score ${checkup.data.score} of 100`
                : 'Checkup, devices, limits and panic button'
            }
            leading={ShieldCheck}
            onPress={() => router.push('/security')}
          />
          <Divider />
          <ListItem
            title="Panic button"
            subtitle={
              panic.data?.active ? 'On: cards frozen, nothing can go out' : 'Freeze everything'
            }
            leading={OctagonX}
            onPress={() => router.push('/security/panic')}
          />
          <Divider />
          <ListItem
            title="Devices and sessions"
            subtitle="Where you’re signed in"
            leading={MonitorSmartphone}
            onPress={() => router.push('/security/devices')}
          />
          <Divider />
          <ListItem
            title="Your limits"
            subtitle="Daily and single-transfer limits"
            leading={Gauge}
            onPress={() => router.push('/security/limits')}
          />
        </Card>
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Account" />
        <Card padded={false}>
          <ListItem
            title="Profile"
            subtitle="Photo, name and @nemtag"
            leading={UserRound}
            onPress={() => router.push('/profile')}
          />
          <Divider />
          <ListItem
            title="Verify your identity"
            subtitle="Raise your limits"
            leading={BadgeCheck}
            onPress={() => router.push('/kyc')}
          />
          <Divider />
          <ListItem
            title="Statements"
            subtitle="Official PDFs with a verification code"
            leading={FileText}
            onPress={() => router.push('/statements')}
          />
        </Card>
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Demo" />
        <Card padded={false}>
          <ListItem
            title="Demo Controls"
            subtitle="Fund the wallet, simulate transfers, reset"
            leading={SlidersHorizontal}
            onPress={() => router.push('/demo-controls')}
          />
          {devToolsEnabled && (
            <>
              <Divider />
              <ListItem
                title="Design system"
                subtitle="Every Volt Noir component"
                leading={LayoutGrid}
                onPress={() => router.push('/kit')}
              />
            </>
          )}
        </Card>
      </View>

      <Card padded={false}>
        <ListItem
          title="Sign out"
          subtitle="Back to the welcome screen"
          leading={LogOut}
          onPress={() => void signOut()}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 44, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  start: { alignItems: 'flex-start' },
});
