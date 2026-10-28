import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { BadgeCheck, Clock } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  Icon,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { kycStatusText, nextTier, UNLOCK_LABELS, upgradeHref } from '../kyc';

const naira = (m: Schema<'Money'>) => formatMoney(fromApiMoney(m), { trimZeroMinor: true });
const maxBalance = (t: Schema<'TierInfo'>) => (t.max_balance ? naira(t.max_balance) : 'No limit');

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant="bodySmall" color="textMuted">
        {label}
      </Text>
      <Text variant="bodySmall" style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

/** KYC tiers (KYC-1): your tier and limits, every tier's limits, and the way up. */
export function KycScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const q = useRepoQuery('kyc', 'getOverview');
  const header = <SendHeader title="Verify identity" first />;
  const overview = q.data;

  if (!overview) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title="We couldn't load your verification" onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading your verification">
            <Skeleton height={140} />
            <Skeleton height={120} />
            <Skeleton height={220} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const current = overview.tiers.find((t) => t.current);
  const next = nextTier(overview.tier);
  const nextInfo = next ? overview.tiers.find((t) => t.tier === next) : undefined;
  const href = upgradeHref(overview);
  const reviewing = overview.status === 'pending_review';

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Card>
        <View style={{ gap: spacing[3] }}>
          <View style={{ gap: spacing[1] }}>
            <Text variant="bodySmall" color="textMuted">
              You’re on
            </Text>
            <View style={[styles.row, { gap: spacing[2] }]}>
              <Text variant="h2">{`Tier ${overview.tier}`}</Text>
              {overview.tier === 3 && (
                <Icon icon={BadgeCheck} color="success" accessibilityLabel="Fully verified" />
              )}
            </View>
            <Text variant="bodySmall" color="textMuted">
              {kycStatusText(overview)}
            </Text>
          </View>
          {current && (
            <View style={{ gap: spacing[2] }}>
              <Fact label="You can send" value={`${naira(current.daily_limit)} a day`} />
              <Fact label="You can hold" value={maxBalance(current)} />
            </View>
          )}
        </View>
      </Card>

      {nextInfo && (
        <Card>
          <View style={{ gap: spacing[3] }}>
            <Text variant="bodyStrong">{`Upgrade to Tier ${nextInfo.tier}`}</Text>
            <Text variant="bodySmall" color="textMuted">
              {`You’ll need: ${nextInfo.requirements.join(', ')}. You’ll get ${naira(nextInfo.daily_limit)} a day${
                nextInfo.unlocks?.length
                  ? ` and ${nextInfo.unlocks.map((u) => UNLOCK_LABELS[u].toLowerCase()).join(', ')}`
                  : ''
              }.`}
            </Text>
            {reviewing ? (
              <View style={[styles.row, { gap: spacing[2] }]}>
                <Icon icon={Clock} color="warning" accessibilityLabel="Waiting" />
                <Text variant="bodySmall">We’re checking your documents.</Text>
              </View>
            ) : (
              <Button
                label={href ? `Upgrade to Tier ${nextInfo.tier}` : 'Soon'}
                disabled={!href}
                onPress={() => href && router.push(href)}
              />
            )}
          </View>
        </Card>
      )}

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Tiers and limits" />
        {overview.tiers.map((t) => (
          <Card key={t.tier}>
            <View style={{ gap: spacing[2] }}>
              <View style={styles.between}>
                <Text variant="bodyStrong" accessibilityRole="header">{`Tier ${t.tier}`}</Text>
                {t.current && <Badge label="Your tier" tone="primary" />}
              </View>
              <Fact label="Daily limit" value={naira(t.daily_limit)} />
              <Fact label="Most you can hold" value={maxBalance(t)} />
              <Divider />
              <Fact label={t.tier === 1 ? 'Needs' : 'Adds'} value={t.requirements.join(', ')} />
              {!!t.unlocks?.length && (
                <Fact label="Unlocks" value={t.unlocks.map((u) => UNLOCK_LABELS[u]).join(', ')} />
              )}
            </View>
          </Card>
        ))}
      </View>

      {overview.demo_limits && (
        <Text variant="caption" color="textMuted">
          Demo limits based on public CBN guidance. The bank can change them.
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  value: { flexShrink: 1, textAlign: 'right' },
});
