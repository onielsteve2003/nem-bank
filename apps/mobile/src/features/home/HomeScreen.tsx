import { useRouter, type Href } from 'expo-router';
import { Eye, EyeOff, ReceiptText, Wallet } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  DemoMoneyBadge,
  EmptyState,
  ErrorState,
  IconButton,
  PressableScale,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  SkeletonListItem,
  Text,
} from '@/components';
import { isApiError } from '@/data';
import { AccountDetailsSheet } from '@/features/accounts/AccountDetailsSheet';
import { AddWalletSheet, addableCurrencies } from '@/features/accounts/AddWalletSheet';
import { BalanceExplainerSheet } from '@/features/accounts/BalanceExplainerSheet';
import { NotificationBell } from '@/features/notifications/components/NotificationBell';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { env } from '@/lib/env';
import { useRepoQuery } from '@/lib/query';
import { usePreferencesStore, usePrivacyStore } from '@/stores';
import { useTheme } from '@/theme';

import { AssistantEntry } from './components/AssistantEntry';
import { BalanceCarousel, type Account } from './components/BalanceCarousel';
import { InsightsTeaser } from './components/InsightsTeaser';
import { QuickActions, type QuickAction } from './components/QuickActions';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';

export const RECENT_COUNT = 5;

/** By the Lagos clock (UTC+1), whatever the phone's time zone. */
export function greetingFor(now: Date = new Date()): string {
  const hour = (now.getUTCHours() + 1) % 24;
  if (hour < 12) return i18n.t('home.greeting.morning');
  if (hour < 17) return i18n.t('home.greeting.afternoon');
  return i18n.t('home.greeting.evening');
}

/** Add money opens the naira account details instead of a route. */
const QUICK_ROUTES: Record<Exclude<QuickAction, 'addMoney'>, Href> = {
  send: '/send',
  convert: '/convert',
  bills: '/bills',
  scan: '/qr',
};

const offline = (error: unknown) => isApiError(error) && error.problem.code === 'offline';

/**
 * Home (PRD §8): a balance card per currency, the five quick actions, recent
 * activity, this month's spending and the way into Nem Assistant. Each section
 * loads, fails and retries on its own, so one slow call never blanks the page.
 */
export function HomeScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const toggleBalances = usePrivacyStore((s) => s.toggleBalances);
  const assistantOn = usePreferencesStore((s) => s.ai.assistant);

  const me = useRepoQuery('users', 'getMe');
  const accounts = useRepoQuery('accounts', 'list');
  const recent = useRepoQuery('transactions', 'list', { query: { limit: RECENT_COUNT } });
  const spending = useRepoQuery('insights', 'getSpending', { query: { currency: 'NGN' } });

  const refreshing = [accounts, recent, spending].some((q) => q.isRefetching);
  const refresh = () => {
    void me.refetch();
    void accounts.refetch();
    void recent.refetch();
    void spending.refetch();
  };

  const [detailsFor, setDetailsFor] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const [explainFor, setExplainFor] = useState<Account | null>(null);
  const canAdd = accounts.data ? addableCurrencies(accounts.data.data).length > 0 : false;
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN') ?? null;
  const addMoney = () => setDetailsFor(naira);
  const onAction = (action: QuickAction) =>
    action === 'addMoney' ? addMoney() : router.push(QUICK_ROUTES[action]);

  const user = me.data;
  const name = user ? (user.preferred_name ?? user.first_name) : '';

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4], gap: spacing[3] }]}>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('home.profile')}
        onPress={() => router.push('/me')}
      >
        <Avatar name={name || 'Nem'} size="md" />
      </PressableScale>
      <View style={styles.flex}>
        <Text variant="caption" color="textMuted">
          {greetingFor()}
        </Text>
        <Text variant="title" numberOfLines={1} accessibilityRole="header">
          {name || ' '}
        </Text>
      </View>
      {user?.is_demo && <DemoMoneyBadge />}
      <IconButton
        icon={hidden ? EyeOff : Eye}
        accessibilityLabel={hidden ? t('home.showBalances') : t('home.hideBalances')}
        variant="ghost"
        onPress={toggleBalances}
      />
      <NotificationBell />
    </View>
  );

  return (
    <Screen
      header={header}
      padded={false}
      edges={['top']}
      onRefresh={refresh}
      refreshing={refreshing}
      contentContainerStyle={{ gap: spacing[6], paddingVertical: spacing[4] }}
    >
      {accounts.data?.data.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title={t('home.noWallets')}
          message={t('home.noWalletsMessage')}
        />
      ) : accounts.data ? (
        <BalanceCarousel
          accounts={accounts.data.data}
          hidden={hidden}
          onOpen={setDetailsFor}
          onAdd={canAdd ? () => setAdding(true) : undefined}
          onExplain={setExplainFor}
        />
      ) : accounts.isError ? (
        <ErrorState
          kind={offline(accounts.error) ? 'offline' : 'error'}
          title={t('home.balancesFailed')}
          onRetry={() => accounts.refetch()}
        />
      ) : (
        <View style={{ paddingHorizontal: spacing[4] }}>
          <SkeletonGroup accessibilityLabel={t('home.loadingBalances')}>
            <Skeleton height={148} radius={24} />
          </SkeletonGroup>
        </View>
      )}

      <QuickActions onAction={onAction} />

      <View style={{ gap: spacing[2] }}>
        <View style={{ paddingHorizontal: spacing[4] }}>
          <SectionHeader
            title={t('home.recent')}
            actionLabel={t('common.seeAll')}
            onAction={() => router.push('/transactions')}
          />
        </View>
        {recent.data ? (
          recent.data.data.length > 0 ? (
            <View style={{ paddingHorizontal: spacing[2] }}>
              {recent.data.data.slice(0, RECENT_COUNT).map((t) => (
                <TransactionRow
                  key={t.id}
                  transaction={t}
                  onPress={() => router.push(`/transactions/${t.id}`)}
                />
              ))}
            </View>
          ) : (
            <EmptyState
              icon={ReceiptText}
              title={t('common.noTransactions')}
              message={t('common.noTransactionsMessage')}
              actionLabel={t('common.addMoney')}
              onAction={addMoney}
            />
          )
        ) : recent.isError ? (
          <ErrorState
            kind={offline(recent.error) ? 'offline' : 'error'}
            title={t('home.activityFailed')}
            onRetry={() => recent.refetch()}
          />
        ) : (
          <SkeletonGroup accessibilityLabel={t('home.loadingActivity')}>
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonListItem key={i} />
            ))}
          </SkeletonGroup>
        )}
      </View>

      {spending.data && (
        <InsightsTeaser
          spending={spending.data}
          hidden={hidden}
          onOpen={() => router.push('/insights')}
        />
      )}

      {/* Mounted only while a wallet is picked; swiping it away still animates out first. */}
      {detailsFor && (
        <AccountDetailsSheet
          account={detailsFor}
          onClose={() => setDetailsFor(null)}
          onAddDemoMoney={
            env.apiMode === 'mock'
              ? () => {
                  setDetailsFor(null);
                  router.push('/demo-controls');
                }
              : undefined
          }
        />
      )}

      {explainFor && (
        <BalanceExplainerSheet
          // Live figures: the sheet follows realtime balance updates while open.
          account={accounts.data?.data.find((a) => a.id === explainFor.id) ?? explainFor}
          hidden={hidden}
          onClose={() => setExplainFor(null)}
        />
      )}
      {adding && accounts.data && (
        <AddWalletSheet
          open
          accounts={accounts.data.data}
          tier={user?.kyc_tier}
          onClose={() => setAdding(false)}
          onOpened={(account) => {
            setAdding(false);
            setDetailsFor(account);
          }}
          onUpgrade={() => {
            setAdding(false);
            router.push('/kyc');
          }}
        />
      )}

      {assistantOn && (
        <AssistantEntry
          onOpen={() => router.push('/assistant')}
          onManage={() =>
            router.push({ pathname: '/ai/[feature]', params: { feature: 'assistant' } })
          }
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  flex: { flex: 1 },
});
