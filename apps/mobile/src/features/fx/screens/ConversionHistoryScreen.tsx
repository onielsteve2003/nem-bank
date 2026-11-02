import type { Schema } from '@nem/contracts';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { ArrowLeftRight } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, View } from 'react-native';

import { EmptyState, ErrorState, Screen, SkeletonGroup, SkeletonListItem } from '@/components';
import { isApiError } from '@/data';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useTheme } from '@/theme';

import { ConversionRow } from '../components/ConversionRow';
import { ConversionSheet } from '../components/ConversionSheet';
import { useConversionPages } from '../hooks/useConversionPages';
import { useTranslation } from 'react-i18next';

type Conversion = Schema<'FxConversion'>;

/**
 * Every conversion, newest first (FX-4): what left, what arrived and at what
 * rate. A row opens the full record, with a way to each wallet's entry.
 */
export function ConversionHistoryScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const list = useConversionPages();
  const { t } = useTranslation();
  const [open, setOpen] = useState<Conversion | null>(null);

  const renderItem = useCallback(
    ({ item }: { item: Conversion }) => (
      <View style={{ paddingHorizontal: spacing[2] }}>
        <ConversionRow conversion={item} onPress={() => setOpen(item)} />
      </View>
    ),
    [spacing],
  );

  const body = list.data ? (
    list.data.length === 0 ? (
      <EmptyState
        icon={ArrowLeftRight}
        title={t('fx.history.none')}
        message={t('fx.history.noneMessage')}
        actionLabel={t('fx.history.convertNow')}
        onAction={() => router.back()}
      />
    ) : (
      <FlashList
        testID="conversions-list"
        data={list.data}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching && !list.isFetchingNextPage}
            onRefresh={() => void list.refetch()}
            tintColor={colors.primaryText}
          />
        }
        ListFooterComponent={
          list.isFetchingNextPage ? (
            <ActivityIndicator
              accessibilityLabel={t('common.loadingMore')}
              color={colors.primaryText}
              style={{ padding: spacing[4] }}
            />
          ) : list.isFetchNextPageError ? (
            <ErrorState
              title={t('common.loadMoreFailed')}
              onRetry={() => void list.fetchNextPage()}
            />
          ) : (
            <View style={{ height: spacing[8] }} />
          )
        }
      />
    )
  ) : list.isError ? (
    <ErrorState
      kind={isApiError(list.error) && list.error.problem.code === 'offline' ? 'offline' : 'error'}
      title={t('fx.history.failed')}
      onRetry={() => void list.refetch()}
    />
  ) : (
    <SkeletonGroup accessibilityLabel={t('fx.history.loading')}>
      {Array.from({ length: 5 }, (_, i) => (
        <SkeletonListItem key={i} />
      ))}
    </SkeletonGroup>
  );

  return (
    <Screen
      header={<SendHeader title={t('fx.screen.history')} />}
      scroll={false}
      padded={false}
      edges={['top']}
    >
      {body}
      {/* Mounted only while a row is open, like Home's wallet sheet. */}
      {open && <ConversionSheet conversion={open} onClose={() => setOpen(null)} />}
    </Screen>
  );
}
