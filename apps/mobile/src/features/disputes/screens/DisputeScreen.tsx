import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Dialog,
  Divider,
  ErrorState,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  StatusTimeline,
  Text,
  useToast,
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
import { DISPUTE_STATUS, isOpen, nextStep, reasonLabel } from '../disputes';

/** The mock bank moves a case along on its own; check back while it's open. */
const OPEN_REFRESH_MS = 10_000;

const message = (e: unknown) =>
  isApiError(e) ? (e.problem.detail ?? e.problem.title) : i18n.t('common.somethingWrong');

/**
 * One dispute (DSP-2): its case number, where it is on the timeline, the
 * payment it's about, your evidence and the outcome, including any refund
 * posted back to your account.
 */
export function DisputeScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { radius, spacing } = useTheme();
  const { t } = useTranslation();
  const path = { dispute_id: id };
  const q = useRepoQuery(
    'disputes',
    'get',
    { path },
    { refetchInterval: (s) => (s.state.data && isOpen(s.state.data) ? OPEN_REFRESH_MS : false) },
  );
  const txnId = q.data?.transaction_id ?? '';
  const txn = useRepoQuery(
    'transactions',
    'get',
    { path: { transaction_id: txnId } },
    { enabled: Boolean(txnId) },
  );
  const invalidates = [queryKeys.domain('disputes'), ['transactions']];
  const addEvidence = useRepoMutation('disputes', 'addEvidence', { invalidates });
  const withdraw = useRepoMutation('disputes', 'withdraw', {
    invalidates,
    onSuccess: () => toast.show({ message: t('disputes.one.withdrawn') }),
    onError: (e) => toast.show({ message: message(e), tone: 'error' }),
  });
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const [confirming, setConfirming] = useState(false);

  const header = <SendHeader title={q.data?.case_number ?? t('disputes.one.title')} />;
  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title={t('disputes.one.failed')} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('disputes.one.loading')}>
            <Skeleton height={100} />
            <Skeleton height={200} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const d = q.data;
  const status = DISPUTE_STATUS[d.status];
  const open = isOpen(d);
  const next = nextStep(d);

  const upload = async () => {
    setUploadError(undefined);
    setUploading(true);
    const failed: string[] = [];
    for (const [i, file] of photos.entries()) {
      try {
        await addEvidence.mutateAsync({
          path,
          body: { file, caption: t('common.photoN', { n: d.evidence.length + i + 1 }) },
        });
      } catch (e) {
        failed.push(file);
        setUploadError(message(e));
      }
    }
    setPhotos(failed);
    setUploading(false);
    if (!failed.length) toast.show({ message: t('disputes.one.evidenceAdded'), tone: 'success' });
  };

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Card>
        <View style={{ gap: spacing[2] }}>
          <View style={[styles.between, { gap: spacing[2] }]}>
            <Text variant="h3" selectable>
              {d.case_number}
            </Text>
            <Badge label={status.label} tone={status.tone} />
          </View>
          <Text variant="bodySmall" color="textMuted">
            {t('disputes.one.reported', {
              reason: reasonLabel(d.reason),
              when: formatDateTime(d.created_at),
            })}
          </Text>
          {d.refund && (
            <View style={[styles.between, { gap: spacing[2] }]}>
              <Text variant="bodyStrong" color="success">
                {t('disputes.one.refunded')}
              </Text>
              <MoneyText value={fromApiMoney(d.refund)} variant="bodyStrong" />
            </View>
          )}
          {d.resolution_note && <Text variant="bodySmall">{d.resolution_note}</Text>}
        </View>
      </Card>

      <SectionHeader title={t('disputes.one.progress')} />
      <Card>
        <StatusTimeline steps={d.timeline} formatAt={formatDateTime} next={next} />
      </Card>

      <SectionHeader title={t('disputes.one.payment')} />
      <Card
        onPress={() =>
          router.push({ pathname: '/transactions/[id]', params: { id: d.transaction_id } })
        }
        accessibilityLabel={t('disputes.one.openPayment')}
      >
        {txn.data ? (
          <View style={[styles.between, { gap: spacing[3] }]}>
            <View style={styles.flex}>
              <Text variant="bodyStrong">{transactionTitle(txn.data)}</Text>
              <Text variant="bodySmall" color="textMuted">
                {formatDateTime(txn.data.created_at)}
              </Text>
            </View>
            <MoneyText value={fromApiMoney(txn.data.amount)} variant="bodyStrong" />
          </View>
        ) : (
          <Skeleton height={40} />
        )}
      </Card>

      <SectionHeader title={t('disputes.one.told')} />
      <Card>
        <View style={{ gap: spacing[3] }}>
          <Text variant="body">{d.description}</Text>
          {d.evidence.length > 0 && (
            <>
              <Divider />
              <View style={[styles.wrap, { gap: spacing[2] }]}>
                {d.evidence.map((a) =>
                  a.content_type === 'application/pdf' ? (
                    <Badge key={a.id} label={a.file_name} />
                  ) : (
                    <Image
                      key={a.id}
                      source={{ uri: a.url }}
                      accessibilityLabel={a.file_name}
                      style={[styles.thumb, { borderRadius: radius.md }]}
                    />
                  ),
                )}
              </View>
            </>
          )}
        </View>
      </Card>

      {open && (
        <>
          <SectionHeader title={t('disputes.one.addEvidence')} />
          <EvidencePicker
            photos={photos}
            onChange={setPhotos}
            existing={d.evidence.length}
            disabled={uploading}
          />
          {uploadError && (
            <Text variant="bodySmall" color="danger">
              {uploadError}
            </Text>
          )}
          {photos.length > 0 && (
            <Button
              label={t('disputes.one.addPhotos', { count: photos.length })}
              loading={uploading}
              onPress={() => void upload()}
            />
          )}
          <Button
            label={t('disputes.one.withdraw')}
            variant="ghost"
            loading={withdraw.isPending}
            onPress={() => setConfirming(true)}
          />
        </>
      )}

      <Dialog
        open={confirming}
        title={t('disputes.one.withdrawTitle')}
        message={t('disputes.one.withdrawMessage')}
        confirmLabel={t('disputes.one.withdrawConfirm')}
        onConfirm={() => {
          setConfirming(false);
          withdraw.mutate({ path });
        }}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  flex: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  thumb: { width: 72, height: 72 },
});
