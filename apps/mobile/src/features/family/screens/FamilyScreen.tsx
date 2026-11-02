import { useRouter } from 'expo-router';
import { ListChecks, UserPlus, Users } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ErrorState,
  MoneyText,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { ageOn, controlsSummary } from '../family';

/** The family hub (FAM-1, FAM-3): your children's accounts and how to add one. */
export function FamilyScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const q = useRepoQuery('family', 'listDependants');
  const approvals = useRepoQuery('family', 'listApprovals', { query: { status: 'pending' } });
  const waiting = approvals.data?.data.length ?? 0;
  const header = <SendHeader title={t('family.title')} first />;
  const add = () => router.push('/family/add');

  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title={t('family.hub.failed')} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('family.hub.loading')}>
            <Skeleton height={160} />
            <Skeleton height={160} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const children = q.data.data;
  if (!children.length) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Users}
          title={t('family.hub.emptyTitle')}
          message={t('family.hub.emptyMessage')}
          actionLabel={t('family.add.title')}
          onAction={add}
        />
      </Screen>
    );
  }

  const now = new Date();
  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Button
        label={
          waiting ? t('family.approvals.waiting', { count: waiting }) : t('family.approvals.title')
        }
        icon={ListChecks}
        variant={waiting ? 'primary' : 'secondary'}
        fullWidth
        onPress={() => router.push('/family/approvals')}
      />
      {children.map((child) => (
        <Card
          key={child.id}
          onPress={() => router.push({ pathname: '/family/[id]', params: { id: child.id } })}
          accessibilityLabel={t('family.hub.rowLabel', { name: child.profile.name })}
        >
          <View style={{ gap: spacing[3] }}>
            <View style={[styles.row, { gap: spacing[3] }]}>
              <Avatar name={child.profile.name} size="md" />
              <View style={[styles.flex, { gap: spacing[1] }]}>
                <Text variant="bodyStrong">{child.profile.name}</Text>
                <Text variant="bodySmall" color="textMuted">
                  {[
                    child.profile.nemtag && `@${child.profile.nemtag}`,
                    t('common.yearsOld', { count: ageOn(child.date_of_birth, now) }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <View style={[styles.end, { gap: spacing[1] }]}>
                <MoneyText value={fromApiMoney(child.balance)} variant="bodyStrong" trimZeroMinor />
                {child.kid_mode && <Badge label={t('common.kidMode')} tone="primary" />}
              </View>
            </View>
            <Divider />
            <View style={{ gap: spacing[1] }}>
              {controlsSummary(child.controls).map((line) => (
                <Text key={line} variant="bodySmall" color="textMuted">
                  {line}
                </Text>
              ))}
              {child.controls.paused && (
                <Text variant="bodySmall" color="warning">
                  {t('family.hub.paused')}
                </Text>
              )}
            </View>
          </View>
        </Card>
      ))}
      <Button
        label={t('family.add.title')}
        icon={UserPlus}
        variant="secondary"
        fullWidth
        onPress={add}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  end: { alignItems: 'flex-end' },
});
