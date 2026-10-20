import { FlashList } from '@shopify/flash-list';
import { CURRENCIES } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ArrowLeft, ReceiptText, Search, SlidersHorizontal, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import {
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  Screen,
  SkeletonGroup,
  SkeletonListItem,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import { useTheme } from '@/theme';

import { FilterSheet } from './FilterSheet';
import {
  activeFilterCount,
  DATE_RANGES,
  groupByDay,
  NO_FILTERS,
  STATUS_LABELS,
  toQuery,
  TYPE_GROUPS,
  type ListRow,
  type TransactionFilters,
} from './filters';
import { TransactionRow } from './TransactionRow';
import { useTransactionPages } from './useTransactionPages';

const SEARCH_DEBOUNCE_MS = 300;

/** The filters that are on, as removable chips under the search field. */
function activeChips(f: TransactionFilters) {
  return [
    ...f.types.map((g) => ({
      key: `type-${g}`,
      label: TYPE_GROUPS[g].label,
      clear: { types: f.types.filter((t) => t !== g) },
    })),
    f.currency && {
      key: 'currency',
      label: CURRENCIES[f.currency].name,
      clear: { currency: null },
    },
    f.status && { key: 'status', label: STATUS_LABELS[f.status], clear: { status: null } },
    f.range && { key: 'range', label: DATE_RANGES[f.range], clear: { range: null } },
  ].filter(Boolean) as { key: string; label: string; clear: Partial<TransactionFilters> }[];
}

/**
 * Every transaction, newest first, grouped by Lagos day (ACC-5). Search is
 * debounced; filters apply from a sheet. FlashList keeps months of history
 * smooth, and the next page loads as the end comes into view.
 */
export function TransactionsScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const [filters, setFilters] = useState<TransactionFilters>(NO_FILTERS);
  const [searchText, setSearchText] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    const id = setTimeout(
      () => setFilters((f) => ({ ...f, search: searchText })),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(id);
  }, [searchText]);

  // One query per filter set and day; `toQuery` reads the clock for date ranges.
  const query = useMemo(() => toQuery(filters), [filters]);
  const list = useTransactionPages(query);
  const rows = useMemo(() => (list.data ? groupByDay(list.data) : []), [list.data]);
  const count = activeFilterCount(filters);
  const chips = activeChips(filters);
  const filtered = count > 0 || filters.search.trim() !== '';

  const header = (
    <View style={{ paddingHorizontal: spacing[4], gap: spacing[3], paddingBottom: spacing[2] }}>
      <View style={[styles.row, { gap: spacing[2] }]}>
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel="Back"
          variant="ghost"
          onPress={() => router.back()}
        />
        <Text variant="title" accessibilityRole="header" style={styles.flex}>
          Transactions
        </Text>
        <IconButton
          icon={SlidersHorizontal}
          accessibilityLabel={count > 0 ? `Filters, ${count} on` : 'Filters'}
          variant="ghost"
          onPress={() => setSheetOpen(true)}
        />
      </View>
      <TextField
        label="Search transactions"
        placeholder="Name, narration or reference"
        leadingIcon={Search}
        value={searchText}
        onChangeText={setSearchText}
        returnKeyType="search"
        autoCorrect={false}
        trailing={
          searchText ? (
            <IconButton
              icon={X}
              accessibilityLabel="Clear search"
              variant="ghost"
              size="sm"
              onPress={() => setSearchText('')}
            />
          ) : undefined
        }
      />
      {chips.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing[2] }}
        >
          {chips.map((c) => (
            <Chip
              key={c.key}
              label={c.label}
              selected
              onRemove={() => setFilters((f) => ({ ...f, ...c.clear }))}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );

  const renderItem = ({ item }: { item: ListRow }) =>
    item.kind === 'day' ? (
      <View
        style={{ paddingHorizontal: spacing[4], paddingTop: spacing[4], paddingBottom: spacing[1] }}
      >
        <Text variant="label" color="textMuted" accessibilityRole="header">
          {item.label}
        </Text>
      </View>
    ) : (
      <View style={{ paddingHorizontal: spacing[2] }}>
        <TransactionRow transaction={item.transaction} timeOnly />
      </View>
    );

  const body = list.data ? (
    rows.length === 0 ? (
      <EmptyState
        icon={ReceiptText}
        title={filtered ? 'No matching transactions' : 'No transactions yet'}
        message={
          filtered
            ? 'Try another search or fewer filters.'
            : 'Money you send, receive or spend shows up here.'
        }
        actionLabel={filtered ? 'Clear filters' : undefined}
        onAction={
          filtered
            ? () => {
                setSearchText('');
                setFilters(NO_FILTERS);
              }
            : undefined
        }
      />
    ) : (
      <FlashList
        testID="transactions-list"
        data={rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.kind}
        renderItem={renderItem}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        keyboardDismissMode="on-drag"
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
              accessibilityLabel="Loading more"
              color={colors.primaryText}
              style={{ padding: spacing[4] }}
            />
          ) : list.isFetchNextPageError ? (
            <ErrorState title="We couldn't load more" onRetry={() => void list.fetchNextPage()} />
          ) : (
            <View style={{ height: spacing[8] }} />
          )
        }
      />
    )
  ) : list.isError ? (
    <ErrorState
      kind={isApiError(list.error) && list.error.problem.code === 'offline' ? 'offline' : 'error'}
      title="We couldn't load your transactions"
      onRetry={() => void list.refetch()}
    />
  ) : (
    <SkeletonGroup accessibilityLabel="Loading transactions">
      {Array.from({ length: 6 }, (_, i) => (
        <SkeletonListItem key={i} />
      ))}
    </SkeletonGroup>
  );

  return (
    <Screen header={header} scroll={false} padded={false} edges={['top']}>
      {body}
      {sheetOpen && (
        <FilterSheet
          open
          value={filters}
          onClose={() => setSheetOpen(false)}
          onApply={(next) => {
            setFilters(next);
            setSheetOpen(false);
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
