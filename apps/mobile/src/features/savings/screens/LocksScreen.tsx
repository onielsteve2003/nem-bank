import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Lock, Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { formatGoalDate } from '../goals';
import { LOCK_STATUS, ratePct, sortLocks, termLabel } from '../locks';

type LockedSaving = Schema<'LockedSaving'>;

/** Every locked saving (SAV-4): active ones soonest to mature first, then the ones that ended. */
export function LocksScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const locks = useRepoQuery('savings', 'listLocks');
  const sorted = locks.data ? sortLocks(locks.data.data) : [];
  const active = sorted.filter((l) => l.status === 'active');
  const ended = sorted.filter((l) => l.status !== 'active');

  const row = (l: LockedSaving) => {
    const amount = hidden ? t('common.masked') : formatMoney(fromApiMoney(l.principal));
    const subtitle =
      l.status === 'active'
        ? t('savings.locks.rowActive', {
            rate: ratePct(l.rate_bps),
            date: formatGoalDate(l.maturity_date),
          })
        : t('savings.locks.rowEnded', { rate: ratePct(l.rate_bps), term: termLabel(l.term_days) });
    return (
      <ListItem
        key={l.id}
        leading={Lock}
        title={t('savings.locks.rowTitle', { amount, term: termLabel(l.term_days) })}
        subtitle={subtitle}
        trailing={
          <Badge
            label={LOCK_STATUS[l.status]}
            tone={
              l.status === 'active' ? 'primary' : l.status === 'matured' ? 'success' : 'neutral'
            }
          />
        }
        onPress={() => router.push({ pathname: '/locks/[id]', params: { id: l.id } })}
        accessibilityLabel={t('savings.locks.rowLabel', {
          amount,
          term: termLabel(l.term_days),
          subtitle,
          status: LOCK_STATUS[l.status],
        })}
      />
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('savings.locks.title')} first />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={t('savings.locks.lockMoney')}
          icon={Plus}
          onPress={() => router.push('/locks/new')}
        />
      }
      onRefresh={() => void locks.refetch()}
      refreshing={locks.isRefetching}
    >
      {locks.isError ? (
        <ErrorState title={t('savings.locks.listFailed')} onRetry={() => locks.refetch()} />
      ) : !locks.data ? (
        <SkeletonGroup accessibilityLabel={t('savings.locks.listLoading')}>
          <Skeleton height={72} />
          <Skeleton height={72} />
        </SkeletonGroup>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Lock}
          title={t('savings.locks.emptyTitle')}
          message={t('savings.locks.emptyMessage')}
        />
      ) : (
        <>
          {active.length > 0 && <Card padded={false}>{active.map(row)}</Card>}
          {ended.length > 0 && (
            <View style={{ gap: spacing[2] }}>
              <SectionHeader title={t('savings.locks.ended')} />
              <Card padded={false}>{ended.map(row)}</Card>
            </View>
          )}
        </>
      )}
    </Screen>
  );
}
