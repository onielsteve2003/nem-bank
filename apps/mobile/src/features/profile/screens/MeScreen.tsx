import { useRouter } from 'expo-router';
import {
  BadgeCheck,
  Bell,
  Bot,
  FileText,
  Flag,
  Gauge,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  MonitorSmartphone,
  OctagonX,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
} from '@/components/icons';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const me = useRepoQuery('users', 'getMe');
  const checkup = useRepoQuery('security', 'getCheckup');
  const panic = useRepoQuery('security', 'getPanic');
  const user = me.data;
  const name = user ? (user.preferred_name ?? `${user.first_name} ${user.last_name}`) : '';

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4] }]}>
      <Text variant="title" accessibilityRole="header">
        {t('me.title')}
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
                <Badge label={t('me.kycTier', { tier: user.kyc_tier })} tone="primary" />
              </View>
            </View>
          </View>
        ) : (
          <SkeletonGroup accessibilityLabel={t('me.loading')}>
            <Skeleton height={72} />
          </SkeletonGroup>
        )}
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('me.security')} />
        <Card padded={false}>
          <ListItem
            title={t('me.securityCenter')}
            subtitle={
              checkup.data
                ? t('me.checkupScore', { score: checkup.data.score })
                : t('me.securityCenterHint')
            }
            leading={ShieldCheck}
            onPress={() => router.push('/security')}
          />
          <Divider />
          <ListItem
            title={t('me.panic')}
            subtitle={panic.data?.active ? t('me.panicOn') : t('me.panicOff')}
            leading={OctagonX}
            onPress={() => router.push('/security/panic')}
          />
          <Divider />
          <ListItem
            title={t('me.devices')}
            subtitle={t('me.devicesHint')}
            leading={MonitorSmartphone}
            onPress={() => router.push('/security/devices')}
          />
          <Divider />
          <ListItem
            title={t('me.limits')}
            subtitle={t('me.limitsHint')}
            leading={Gauge}
            onPress={() => router.push('/security/limits')}
          />
        </Card>
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('me.account')} />
        <Card padded={false}>
          <ListItem
            title={t('me.profile')}
            subtitle={t('me.profileHint')}
            leading={UserRound}
            onPress={() => router.push('/profile')}
          />
          <Divider />
          <ListItem
            title={t('me.kyc')}
            subtitle={t('me.kycHint')}
            leading={BadgeCheck}
            onPress={() => router.push('/kyc')}
          />
          <Divider />
          <ListItem
            title={t('me.family')}
            subtitle={t('me.familyHint')}
            leading={Users}
            onPress={() => router.push('/family')}
          />
          <Divider />
          <ListItem
            title={t('me.disputes')}
            subtitle={t('me.disputesHint')}
            leading={Flag}
            onPress={() => router.push('/disputes')}
          />
          <Divider />
          <ListItem
            title={t('me.notifications')}
            subtitle={t('me.notificationsHint')}
            leading={Bell}
            onPress={() => router.push('/notifications')}
          />
          <Divider />
          <ListItem
            title={t('me.statements')}
            subtitle={t('me.statementsHint')}
            leading={FileText}
            onPress={() => router.push('/statements')}
          />
          <Divider />
          <ListItem
            title={t('me.ai')}
            subtitle={t('me.aiHint')}
            leading={Bot}
            onPress={() => router.push('/ai')}
          />
        </Card>
      </View>

      <Card padded={false}>
        <ListItem
          title={t('me.settings')}
          subtitle={t('me.settingsHint')}
          leading={Settings}
          onPress={() => router.push('/settings')}
        />
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('me.help')} />
        <Card padded={false}>
          <ListItem
            title={t('me.support')}
            subtitle={t('me.supportHint')}
            leading={LifeBuoy}
            onPress={() => router.push('/support')}
          />
        </Card>
      </View>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('me.demo')} />
        <Card padded={false}>
          <ListItem
            title={t('me.demoControls')}
            subtitle={t('me.demoControlsHint')}
            leading={SlidersHorizontal}
            onPress={() => router.push('/demo-controls')}
          />
          {devToolsEnabled && (
            <>
              <Divider />
              <ListItem
                title={t('me.designSystem')}
                subtitle={t('me.designSystemHint')}
                leading={LayoutGrid}
                onPress={() => router.push('/kit')}
              />
            </>
          )}
        </Card>
      </View>

      <Card padded={false}>
        <ListItem
          title={t('me.signOut')}
          subtitle={t('me.signOutHint')}
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
