import { useLocalSearchParams, useRouter } from 'expo-router';
import { CircleCheck } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  ErrorState,
  Icon,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import { transactionTitle } from '@/features/transactions/TransactionRow';
import { formatDateTime } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { queryKeys, useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { EvidencePicker } from '../components/EvidencePicker';
import { DESCRIPTION_MAX, descriptionProblem, REASONS, type Reason } from '../disputes';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('common.somethingWrong');

/**
 * Reporting a problem with a payment (DSP-1): what went wrong, in your words,
 * with photos if you have them. The bank answers with a case number you can
 * track.
 */
export function NewDisputeScreen() {
  const { transaction = '' } = useLocalSearchParams<{ transaction: string }>();
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const txn = useRepoQuery('transactions', 'get', { path: { transaction_id: transaction } });
  const create = useRepoMutation('disputes', 'create', {
    invalidates: [queryKeys.domain('disputes'), ['transactions']],
  });
  const addEvidence = useRepoMutation('disputes', 'addEvidence');

  const [reason, setReason] = useState<Reason>();
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState<{ id: string; case: string; missed: number }>();

  const header = <SendHeader title={t('disputes.new.title')} />;
  const problem = descriptionProblem(description);

  if (created) {
    return (
      <Screen
        header={header}
        edges={['top', 'bottom']}
        footer={
          <Button
            label={t('disputes.new.track')}
            fullWidth
            onPress={() =>
              router.replace({ pathname: '/disputes/[id]', params: { id: created.id } })
            }
          />
        }
      >
        <View style={[styles.center, { gap: spacing[3], paddingTop: spacing[8] }]}>
          <Icon icon={CircleCheck} size="xl" color="success" />
          <Text variant="h2" accessibilityRole="header">
            {t('disputes.new.gotIt')}
          </Text>
          <Text variant="body" color="textMuted" style={styles.centerText}>
            {t('disputes.new.caseIs')}
          </Text>
          <Text
            variant="h3"
            selectable
            accessibilityLabel={t('disputes.new.caseLabel', { case: created.case })}
          >
            {created.case}
          </Text>
          <Text variant="bodySmall" color="textMuted" style={styles.centerText}>
            {t('disputes.new.updates')}
          </Text>
          {created.missed > 0 && (
            <Text variant="bodySmall" color="warning" style={styles.centerText}>
              {t('disputes.new.missed', { count: created.missed })}
            </Text>
          )}
        </View>
      </Screen>
    );
  }

  const submit = async () => {
    if (!reason || problem) return;
    setError(undefined);
    setSending(true);
    try {
      const dispute = await create.mutateAsync({
        body: { transaction_id: transaction, reason, description: description.trim() },
      });
      let missed = 0;
      for (const [i, file] of photos.entries()) {
        try {
          await addEvidence.mutateAsync({
            path: { dispute_id: dispute.id },
            body: { file, caption: t('common.photoN', { n: i + 1 }) },
          });
        } catch {
          missed += 1;
        }
      }
      setCreated({ id: dispute.id, case: dispute.case_number, missed });
    } catch (e) {
      setError(message(e));
    } finally {
      setSending(false);
    }
  };

  const footer = (
    <View style={{ gap: spacing[2] }}>
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
      <Button
        label={t('disputes.new.send')}
        fullWidth
        loading={sending}
        disabled={!reason || Boolean(problem)}
        onPress={() => void submit()}
      />
    </View>
  );

  return (
    <Screen header={header} edges={['top', 'bottom']} footer={footer}>
      {txn.isError ? (
        <ErrorState title={t('common.paymentFailed')} onRetry={() => txn.refetch()} />
      ) : !txn.data ? (
        <Skeleton height={72} />
      ) : (
        <Card>
          <View style={[styles.row, { gap: spacing[3] }]}>
            <View style={styles.flex}>
              <Text variant="bodyStrong">{transactionTitle(txn.data)}</Text>
              <Text variant="bodySmall" color="textMuted">
                {formatDateTime(txn.data.created_at)}
              </Text>
            </View>
            <MoneyText value={fromApiMoney(txn.data.amount)} variant="bodyStrong" />
          </View>
        </Card>
      )}

      <SectionHeader title={t('disputes.new.whatWrong')} />
      <View accessibilityRole="radiogroup" style={{ gap: spacing[2] }}>
        {REASONS.map((r) => {
          const selected = reason === r.value;
          return (
            <Pressable
              key={r.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={r.label}
              accessibilityHint={r.hint}
              onPress={() => setReason(r.value)}
              style={[
                {
                  padding: spacing[3],
                  borderRadius: radius.md,
                  borderWidth: 1.5,
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: colors.surface,
                  gap: spacing[1],
                },
              ]}
            >
              <Text variant="bodyStrong">{r.label}</Text>
              <Text variant="bodySmall" color="textMuted">
                {r.hint}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <SectionHeader title={t('disputes.new.tellMore')} />
      <TextField
        label={t('disputes.new.whatHappened')}
        value={description}
        onChangeText={setDescription}
        onBlur={() => setTouched(true)}
        multiline
        maxLength={DESCRIPTION_MAX}
        placeholder={t('disputes.new.placeholder')}
        error={touched ? problem : undefined}
        help={`${description.trim().length} / ${DESCRIPTION_MAX}`}
      />

      <SectionHeader title={t('disputes.new.evidence')} />
      <EvidencePicker photos={photos} onChange={setPhotos} disabled={sending} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
});
