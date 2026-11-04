import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { BadgeCheck, CircleX, Clock, RotateCcw } from '@/components/icons';
import { useTranslation } from 'react-i18next';
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
import i18n from '@/lib/i18n';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { kycStatusText, nextTier, reviewState, UNLOCK_LABELS, upgradeHref } from '../kyc';

const REVIEW_ICONS = {
  pending: { icon: Clock, color: 'warning', label: 'kyc.tiers.waiting' },
  rejected: { icon: CircleX, color: 'danger', label: 'kyc.tiers.notApproved' },
  resubmit: { icon: RotateCcw, color: 'warning', label: 'kyc.tiers.needsDocument' },
} as const;

const sentAt = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

const naira = (m: Schema<'Money'>) => formatMoney(fromApiMoney(m), { trimZeroMinor: true });
const maxBalance = (tier: Schema<'TierInfo'>) =>
  tier.max_balance ? naira(tier.max_balance) : i18n.t('common.noLimit');

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={styles.between}
      accessible
      accessibilityLabel={i18n.t('kyc.tiers.fact', { label, value })}
    >
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
  const { t } = useTranslation();
  const q = useRepoQuery('kyc', 'getOverview');
  const header = <SendHeader title={t('kyc.title')} first />;
  const overview = q.data;

  if (!overview) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title={t('kyc.tiers.failed')} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('kyc.tiers.loading')}>
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
  const review = next === 3 ? reviewState(overview.latest_submission) : null;

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
              {t('kyc.tiers.youreOn')}
            </Text>
            <View style={[styles.row, { gap: spacing[2] }]}>
              <Text variant="h2">{t('kyc.tiers.tier', { tier: overview.tier })}</Text>
              {overview.tier === 3 && (
                <Icon icon={BadgeCheck} color="success" accessibilityLabel={t('kyc.tiers.full')} />
              )}
            </View>
            <Text variant="bodySmall" color="textMuted">
              {kycStatusText(overview)}
            </Text>
          </View>
          {current && (
            <View style={{ gap: spacing[2] }}>
              <Fact
                label={t('kyc.tiers.canSend')}
                value={t('kyc.tiers.perDay', { amount: naira(current.daily_limit) })}
              />
              <Fact label={t('kyc.tiers.canHold')} value={maxBalance(current)} />
              {overview.latest_submission?.status === 'approved' &&
                overview.latest_submission.reviewed_at && (
                  <Fact
                    label={t('kyc.tiers.approved')}
                    value={sentAt.format(new Date(overview.latest_submission.reviewed_at))}
                  />
                )}
            </View>
          )}
        </View>
      </Card>

      {nextInfo && (
        <Card>
          <View style={{ gap: spacing[3] }}>
            <Text variant="bodyStrong">{t('kyc.tiers.upgradeTo', { tier: nextInfo.tier })}</Text>
            <Text variant="bodySmall" color="textMuted">
              {nextInfo.unlocks?.length
                ? t('kyc.tiers.youNeedUnlocks', {
                    requirements: nextInfo.requirements.join(', '),
                    amount: naira(nextInfo.daily_limit),
                    unlocks: nextInfo.unlocks.map((u) => UNLOCK_LABELS[u].toLowerCase()).join(', '),
                  })
                : t('kyc.tiers.youNeed', {
                    requirements: nextInfo.requirements.join(', '),
                    amount: naira(nextInfo.daily_limit),
                  })}
            </Text>
            {review && overview.latest_submission && (
              <View
                style={[styles.row, styles.top, { gap: spacing[3] }]}
                accessible
                accessibilityLiveRegion="polite"
              >
                <Icon
                  icon={REVIEW_ICONS[review.status].icon}
                  color={REVIEW_ICONS[review.status].color}
                  accessibilityLabel={t(REVIEW_ICONS[review.status].label)}
                />
                <View style={[styles.flex, { gap: spacing[1] }]}>
                  <Text variant="bodyStrong">{review.title}</Text>
                  <Text variant="bodySmall" color="textMuted">
                    {review.message}
                  </Text>
                  <Text variant="caption" color="textMuted">
                    {t('kyc.tiers.sent', {
                      when: sentAt.format(new Date(overview.latest_submission.submitted_at)),
                    })}
                  </Text>
                </View>
              </View>
            )}
            {review?.status !== 'pending' && (
              <Button
                label={
                  review?.action ??
                  (href ? t('kyc.tiers.upgradeTo', { tier: nextInfo.tier }) : t('kyc.tiers.soon'))
                }
                disabled={!href}
                onPress={() => href && router.push(href)}
              />
            )}
          </View>
        </Card>
      )}

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('kyc.tiers.tiersAndLimits')} />
        {overview.tiers.map((tier) => (
          <Card key={tier.tier}>
            <View style={{ gap: spacing[2] }}>
              <View style={styles.between}>
                <Text variant="bodyStrong" accessibilityRole="header">
                  {t('kyc.tiers.tier', { tier: tier.tier })}
                </Text>
                {tier.current && <Badge label={t('kyc.tiers.yourTier')} tone="primary" />}
              </View>
              <Fact label={t('kyc.tiers.dailyLimit')} value={naira(tier.daily_limit)} />
              <Fact label={t('kyc.tiers.mostHold')} value={maxBalance(tier)} />
              <Divider />
              <Fact
                label={t(tier.tier === 1 ? 'kyc.tiers.needs' : 'kyc.tiers.adds')}
                value={tier.requirements.join(', ')}
              />
              {!!tier.unlocks?.length && (
                <Fact
                  label={t('kyc.tiers.unlocksLabel')}
                  value={tier.unlocks.map((u) => UNLOCK_LABELS[u]).join(', ')}
                />
              )}
            </View>
          </Card>
        ))}
      </View>

      {overview.demo_limits && (
        <Text variant="caption" color="textMuted">
          {t('kyc.tiers.demo')}
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  top: { alignItems: 'flex-start' },
  flex: { flex: 1 },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  value: { flexShrink: 1, textAlign: 'right' },
});
