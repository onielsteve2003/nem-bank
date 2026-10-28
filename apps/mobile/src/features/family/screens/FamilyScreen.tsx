import { useRouter } from 'expo-router';
import { UserPlus, Users } from 'lucide-react-native';
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
  const q = useRepoQuery('family', 'listDependants');
  const header = <SendHeader title="Family" first />;
  const add = () => router.push('/family/add');

  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title="We couldn't load your family" onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading your family">
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
          title="Add your child"
          message="They get their own login, a simpler kid mode and a naira account. You set what they can spend and approve bigger payments."
          actionLabel="Add a child"
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
      {children.map((child) => (
        <Card key={child.id}>
          <View style={{ gap: spacing[3] }}>
            <View style={[styles.row, { gap: spacing[3] }]}>
              <Avatar name={child.profile.name} size="md" />
              <View style={[styles.flex, { gap: spacing[1] }]}>
                <Text variant="bodyStrong">{child.profile.name}</Text>
                <Text variant="bodySmall" color="textMuted">
                  {[
                    child.profile.nemtag && `@${child.profile.nemtag}`,
                    `${ageOn(child.date_of_birth, now)} years old`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
              <View style={[styles.end, { gap: spacing[1] }]}>
                <MoneyText value={fromApiMoney(child.balance)} variant="bodyStrong" trimZeroMinor />
                {child.kid_mode && <Badge label="Kid mode" tone="primary" />}
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
                  Spending is paused
                </Text>
              )}
            </View>
          </View>
        </Card>
      ))}
      <Button label="Add a child" icon={UserPlus} variant="secondary" fullWidth onPress={add} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  end: { alignItems: 'flex-end' },
});
