import type { Schema } from '@nem/contracts';
import { CURRENCIES } from '@nem/shared';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Copy, FileText } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  ErrorState,
  IconButton,
  MoneyText,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { detailRows } from '@/features/accounts/receivingDetails';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { shareHtmlAsPdf } from '@/lib/share';
import { useTheme } from '@/theme';

import { QrCode } from './QrCode';
import {
  formatDay,
  statementHtml,
  statementTitle,
  statementTotals,
  type StatementHolder,
} from './statements';
import { useStatementLines } from './useStatementLines';

/** Holder block for the PDF: the first receiving detail (account number or IBAN), masked. */
export function holderOf(account: Schema<'Account'>): StatementHolder {
  const d = account.receiving_details;
  const id = detailRows(d).find((r) => /account number|iban/i.test(r.label))?.copy ?? '';
  return { name: d.account_name, account: `****${id.slice(-4)}`, bankName: d.bank_name };
}

/**
 * One statement (ACC-8). While the bank prepares it the screen polls; when it
 * is ready it previews the PDF's summary and verification block, and shares the
 * full PDF with every line.
 */
export function StatementScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { spacing } = useTheme();
  const toast = useToast();
  const [sharing, setSharing] = useState(false);
  const query = useRepoQuery(
    'statements',
    'get',
    { path: { statement_id: id } },
    { refetchInterval: (q) => (q.state.data?.status === 'generating' ? 1_000 : false) },
  );
  const s = query.data;
  const account = useRepoQuery(
    'accounts',
    'get',
    { path: { account_id: s?.account_id ?? '' } },
    { enabled: !!s },
  );
  const lines = useStatementLines(s);

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    haptic('success');
    toast.show({ message: `${label} copied`, tone: 'success' });
  };

  const share = async () => {
    if (!s || !account.data || !lines.data) return;
    setSharing(true);
    try {
      await shareHtmlAsPdf(statementHtml(s, holderOf(account.data), lines.data), statementTitle(s));
      haptic('success');
    } catch {
      toast.show({ message: "We couldn't make the PDF. Try again.", tone: 'error' });
    } finally {
      setSharing(false);
    }
  };

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <IconButton
        icon={ArrowLeft}
        accessibilityLabel="Back"
        variant="ghost"
        onPress={() => router.back()}
      />
      <Text variant="title" accessibilityRole="header">
        Statement
      </Text>
    </View>
  );

  if (!s || s.status === 'generating') {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {query.isError ? (
          <ErrorState
            title="We couldn't load this statement"
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <Text color="textMuted" accessibilityLiveRegion="polite">
              Preparing your statement. This takes a few seconds.
            </Text>
            <SkeletonGroup accessibilityLabel="Preparing statement">
              <Skeleton height={160} radius={24} />
              <Skeleton height={240} radius={24} />
            </SkeletonGroup>
          </>
        )}
      </Screen>
    );
  }

  if (s.status === 'failed') {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <ErrorState title="We couldn't prepare this statement" onRetry={() => router.back()} />
      </Screen>
    );
  }

  const totals = lines.data ? statementTotals(s, lines.data) : null;
  const ready = !!account.data && !!lines.data;

  return (
    <Screen header={header} edges={['top', 'bottom']}>
      <Card>
        <View style={{ gap: spacing[3] }}>
          <Text variant="bodyStrong">
            {CURRENCIES[s.currency].flag} {CURRENCIES[s.currency].name}
          </Text>
          <Text color="textMuted">
            {formatDay(s.period_from)} to {formatDay(s.period_to)}
          </Text>
          <View style={[styles.row, styles.between]}>
            <View>
              <Text variant="caption" color="textMuted">
                Opening balance
              </Text>
              {s.opening_balance && <MoneyText value={fromApiMoney(s.opening_balance)} />}
            </View>
            <View style={styles.end}>
              <Text variant="caption" color="textMuted">
                Closing balance
              </Text>
              {s.closing_balance && <MoneyText value={fromApiMoney(s.closing_balance)} />}
            </View>
          </View>
          {totals && lines.data && (
            <Text variant="caption" color="textMuted">
              {lines.data.length} transactions · in {totals.moneyIn} · out {totals.moneyOut}
            </Text>
          )}
        </View>
      </Card>

      <Card>
        <View style={[styles.row, { gap: spacing[4] }]}>
          {s.verification_url && (
            <QrCode
              value={s.verification_url}
              size={112}
              accessibilityLabel="QR code that opens the verification page"
            />
          )}
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <Text variant="label" color="textMuted">
              Verification code
            </Text>
            <Text variant="bodyStrong" selectable>
              {s.verification_code}
            </Text>
            <Text variant="caption" color="textMuted">
              Anyone can scan the code or open {s.verification_url} to check this statement.
            </Text>
          </View>
        </View>
        {s.sha256 && (
          <View style={[styles.row, { gap: spacing[2], marginTop: spacing[3] }]}>
            <Text variant="caption" color="textMuted" style={styles.flex} selectable>
              SHA-256 {s.sha256}
            </Text>
            <IconButton
              icon={Copy}
              accessibilityLabel="Copy hash"
              variant="ghost"
              size="sm"
              onPress={() => void copy('Hash', s.sha256!)}
            />
          </View>
        )}
      </Card>

      {lines.isError || account.isError ? (
        <ErrorState
          title="We couldn't load the statement lines"
          onRetry={() => void Promise.all([lines.refetch(), account.refetch()])}
        />
      ) : (
        <Button
          label="Share PDF"
          icon={FileText}
          loading={sharing || !ready}
          disabled={!ready}
          onPress={() => void share()}
        />
      )}
      <Text variant="caption" color="textMuted" style={styles.center}>
        Demo bank. Simulated money, not a real bank document.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { justifyContent: 'space-between' },
  end: { alignItems: 'flex-end' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
});
