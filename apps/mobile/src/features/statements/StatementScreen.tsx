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
import { useTranslation } from 'react-i18next';

/** Holder block for the PDF: the first receiving detail (account number or IBAN), masked. */
export function holderOf(account: Schema<'Account'>): StatementHolder {
  const d = account.receiving_details;
  const id = detailRows(d).find((r) => r.id === 'accountNumber' || r.id === 'iban')?.copy ?? '';
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
  const { t } = useTranslation();
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
    toast.show({ message: t('common.copied', { label }), tone: 'success' });
  };

  const share = async () => {
    if (!s || !account.data || !lines.data) return;
    setSharing(true);
    try {
      await shareHtmlAsPdf(statementHtml(s, holderOf(account.data), lines.data), statementTitle(s));
      haptic('success');
    } catch {
      toast.show({ message: t('statements.detail.pdfFailed'), tone: 'error' });
    } finally {
      setSharing(false);
    }
  };

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <IconButton
        icon={ArrowLeft}
        accessibilityLabel={t('common.back')}
        variant="ghost"
        onPress={() => router.back()}
      />
      <Text variant="title" accessibilityRole="header">
        {t('statements.detail.title')}
      </Text>
    </View>
  );

  if (!s || s.status === 'generating') {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {query.isError ? (
          <ErrorState title={t('statements.detail.failed')} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <Text color="textMuted" accessibilityLiveRegion="polite">
              {t('statements.detail.preparing')}
            </Text>
            <SkeletonGroup accessibilityLabel={t('statements.detail.preparingLabel')}>
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
        <ErrorState title={t('statements.detail.prepareFailed')} onRetry={() => router.back()} />
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
            {t('statements.detail.range', {
              from: formatDay(s.period_from),
              to: formatDay(s.period_to),
            })}
          </Text>
          <View style={[styles.row, styles.between]}>
            <View>
              <Text variant="caption" color="textMuted">
                {t('statements.detail.opening')}
              </Text>
              {s.opening_balance && <MoneyText value={fromApiMoney(s.opening_balance)} />}
            </View>
            <View style={styles.end}>
              <Text variant="caption" color="textMuted">
                {t('statements.detail.closing')}
              </Text>
              {s.closing_balance && <MoneyText value={fromApiMoney(s.closing_balance)} />}
            </View>
          </View>
          {totals && lines.data && (
            <Text variant="caption" color="textMuted">
              {t('statements.detail.summary', {
                count: lines.data.length,
                moneyIn: totals.moneyIn,
                moneyOut: totals.moneyOut,
              })}
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
              accessibilityLabel={t('statements.detail.qr')}
            />
          )}
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <Text variant="label" color="textMuted">
              {t('statements.detail.code')}
            </Text>
            <Text variant="bodyStrong" selectable>
              {s.verification_code}
            </Text>
            <Text variant="caption" color="textMuted">
              {t('statements.detail.anyone', { url: s.verification_url })}
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
              accessibilityLabel={t('statements.detail.copyHash')}
              variant="ghost"
              size="sm"
              onPress={() => void copy(t('statements.detail.hash'), s.sha256!)}
            />
          </View>
        )}
      </Card>

      {lines.isError || account.isError ? (
        <ErrorState
          title={t('statements.detail.linesFailed')}
          onRetry={() => void Promise.all([lines.refetch(), account.refetch()])}
        />
      ) : (
        <Button
          label={t('statements.detail.share')}
          icon={FileText}
          loading={sharing || !ready}
          disabled={!ready}
          onPress={() => void share()}
        />
      )}
      <Text variant="caption" color="textMuted" style={styles.center}>
        {t('common.demoDocument')}
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
