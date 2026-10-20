import { CURRENCIES, lagosToday, parseDisplayDate, statementRangeError } from '@nem/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, FileText } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  ListItem,
  SectionHeader,
  Screen,
  SelectSheet,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
  useToast,
} from '@/components';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { periodRange, PERIODS, statementTitle, type Period } from './statements';

const STATUS_WORDS = { generating: 'Preparing', ready: 'Ready', failed: 'Failed' } as const;

/**
 * Request an official statement (ACC-8): pick a wallet and a period of up to
 * 12 months, and the bank prepares a PDF with a verification hash and QR.
 * Earlier statements are listed underneath.
 */
export function StatementsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ account?: string }>();
  const { spacing } = useTheme();
  const toast = useToast();
  const accounts = useRepoQuery('accounts', 'list');
  const history = useRepoQuery('statements', 'list');
  const [accountId, setAccountId] = useState<string | null>(params.account ?? null);
  const [period, setPeriod] = useState<Period>('last_month');
  const [custom, setCustom] = useState({ from: '', to: '' });

  const request = useRepoMutation('statements', 'request', {
    invalidates: [['statements']],
    onSuccess: (s) => router.push({ pathname: '/statements/[id]', params: { id: s.id } }),
    onError: (e) =>
      toast.show({
        message: e.problem.detail ?? "We couldn't start the statement.",
        tone: 'error',
      }),
  });

  const today = lagosToday();
  const range =
    period === 'custom'
      ? { from: parseDisplayDate(custom.from), to: parseDisplayDate(custom.to) }
      : periodRange(period, today);
  const rangeError =
    range.from && range.to
      ? statementRangeError(range.from, range.to, today)
      : period === 'custom' && custom.from.length === 10 && custom.to.length === 10
        ? 'Use real dates in DD/MM/YYYY'
        : null;
  const options = (accounts.data?.data ?? []).map((a) => ({
    value: a.id,
    label: `${CURRENCIES[a.currency].flag} ${CURRENCIES[a.currency].name}`,
  }));
  const chosen = accountId ?? options[0]?.value ?? null;
  const canSubmit = chosen !== null && range.from && range.to && !rangeError;

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <IconButton
        icon={ArrowLeft}
        accessibilityLabel="Back"
        variant="ghost"
        onPress={() => router.back()}
      />
      <Text variant="title" accessibilityRole="header">
        Statements
      </Text>
    </View>
  );

  return (
    <Screen header={header} edges={['top', 'bottom']}>
      <Card>
        <View style={{ gap: spacing[4] }}>
          <Text color="textMuted">
            An official PDF for visas, rent or loans. Each one carries a code anyone can check.
          </Text>
          <SelectSheet
            label="Wallet"
            options={options}
            value={chosen}
            onChange={setAccountId}
            disabled={options.length < 2}
          />
          <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
            {(Object.keys(PERIODS) as Period[]).map((p) => (
              <Chip
                key={p}
                label={PERIODS[p]}
                selected={period === p}
                onPress={() => setPeriod(p)}
              />
            ))}
          </View>
          {period === 'custom' && (
            <View style={[styles.row, { gap: spacing[3] }]}>
              <TextField
                label="From"
                placeholder="DD/MM/YYYY"
                keyboardType="numbers-and-punctuation"
                value={custom.from}
                onChangeText={(from) => setCustom((c) => ({ ...c, from }))}
                style={styles.flex}
              />
              <TextField
                label="To"
                placeholder="DD/MM/YYYY"
                keyboardType="numbers-and-punctuation"
                value={custom.to}
                onChangeText={(to) => setCustom((c) => ({ ...c, to }))}
                style={styles.flex}
              />
            </View>
          )}
          {rangeError && (
            <Text color="danger" accessibilityRole="alert">
              {rangeError}
            </Text>
          )}
          <Button
            label="Get statement"
            icon={FileText}
            loading={request.isPending}
            disabled={!canSubmit}
            onPress={() =>
              chosen &&
              range.from &&
              range.to &&
              request.mutate({ body: { account_id: chosen, from: range.from, to: range.to } })
            }
          />
        </View>
      </Card>

      <SectionHeader title="Your statements" />
      {history.data ? (
        history.data.data.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No statements yet"
            message="The ones you request appear here."
          />
        ) : (
          <Card padded={false}>
            {history.data.data.map((s) => (
              <ListItem
                key={s.id}
                leading={FileText}
                title={statementTitle(s)}
                subtitle={STATUS_WORDS[s.status]}
                showChevron
                onPress={() => router.push({ pathname: '/statements/[id]', params: { id: s.id } })}
              />
            ))}
          </Card>
        )
      ) : history.isError ? (
        <ErrorState
          title="We couldn't load your statements"
          onRetry={() => void history.refetch()}
        />
      ) : (
        <SkeletonGroup accessibilityLabel="Loading statements">
          <Skeleton height={64} radius={16} />
          <Skeleton height={64} radius={16} />
        </SkeletonGroup>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  flex: { flex: 1 },
});
