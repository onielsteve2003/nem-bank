import type { Schema } from '@nem/contracts';
import { parseDisplayDate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Clock, RotateCcw, ScanText, ShieldAlert } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  ErrorState,
  Icon,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import { formatDateEntry } from '@/features/auth/signupForm';
import { addressComplete, toApiAddress, type DeliveryAddress } from '@/features/cards/cards';
import { AddressFields } from '@/features/cards/components/AddressFields';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { PhotoCapture } from '../components/PhotoCapture';
import {
  displayDate,
  expiryProblem,
  ID_DOCUMENTS,
  idNumberProblem,
  photoProblem,
  reviewState,
  stepsToFix,
  type IdDocument,
} from '../kyc';

type Doc = Schema<'KycDocument'>;
const STEP_COUNT = 4;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('kyc.tier3.sendFailed');

const usable = (d: Doc | undefined): d is Doc => Boolean(d && !photoProblem(d));

/**
 * Tier 3 (KYC-3, KYC-4): a photo of a government ID, a selfie, the ID's
 * details (optionally read from the photo by AI, with consent) and an address,
 * then off to a reviewer.
 */
export function DocumentsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const overview = useRepoQuery('kyc', 'getOverview');
  const prefillOn = usePreferencesStore((s) => s.ai.idPrefill);
  const setAiFeature = usePreferencesStore((s) => s.setAiFeature);
  const prefill = useRepoMutation('kyc', 'prefill', { invalidates: [] });
  const submit = useRepoMutation('kyc', 'submit', { invalidates: [[]] });

  const [step, setStep] = useState(0);
  const [idType, setIdType] = useState<IdDocument>('national_id');
  const [front, setFront] = useState<Doc>();
  const [selfie, setSelfie] = useState<Doc>();
  const [idNumber, setIdNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [prefilled, setPrefilled] = useState<Schema<'IdPrefill'>>();
  const [address, setAddress] = useState<DeliveryAddress>({
    line1: '',
    line2: '',
    city: '',
    state: '',
    postalCode: '',
  });
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);

  const header = <SendHeader title={t('kyc.tier3.title')} />;
  if (!overview.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {overview.isError ? (
          <ErrorState title={t('kyc.tier3.failed')} onRetry={() => overview.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('common.loading')}>
            <Skeleton height={320} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  if (sent) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Clock}
          title={t('kyc.review.pendingTitle')}
          message={t('kyc.tier3.sentMessage')}
        />
        <Button label={t('common.done')} fullWidth onPress={() => router.back()} />
      </Screen>
    );
  }

  if (overview.data.tier < 2) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={ShieldAlert}
          title={t('kyc.tier3.needTier2')}
          message={t('kyc.tier3.needTier2Message')}
          actionLabel={t('kyc.tier3.verifyId')}
          onAction={() => router.replace('/kyc/identity')}
        />
      </Screen>
    );
  }

  const expiryIso = parseDisplayDate(expiry);
  const numberProblem = idNumberProblem(idType, idNumber);
  const dateProblem = expiryProblem(expiryIso, expiry, new Date());
  const detailsReady =
    ID_DOCUMENTS[idType].pattern.test(idNumber.trim().toUpperCase()) &&
    !dateProblem &&
    (!expiry || Boolean(expiryIso));
  const ready = [usable(front), usable(selfie), detailsReady, addressComplete(address)][step];

  const readId = () => {
    if (!usable(front)) return;
    setError(undefined);
    prefill.mutate(
      { body: { document_id: front.id, consent: true } },
      {
        onSuccess: (result) => {
          setPrefilled(result);
          const f = result.fields;
          if (f.id_type) setIdType(f.id_type);
          if (f.id_number) setIdNumber(f.id_number);
          if (f.expiry_date) setExpiry(displayDate(f.expiry_date));
        },
        onError: (e) => setError(message(e)),
      },
    );
  };

  const send = () => {
    if (!usable(front) || !usable(selfie)) return;
    setError(undefined);
    submit.mutate(
      {
        body: {
          target_tier: 3,
          id_type: idType,
          id_number: idNumber.trim().toUpperCase(),
          ...(expiryIso && { id_expiry_date: expiryIso }),
          document_ids: [front.id, selfie.id],
          address: toApiAddress(address),
        },
      },
      { onSuccess: () => setSent(true), onError: (e) => setError(message(e)) },
    );
  };

  // After a rejection or a resubmit request, say what to fix where it applies.
  const review = reviewState(overview.data.latest_submission);
  const fixHere =
    review &&
    review.status !== 'pending' &&
    (step === 0 || stepsToFix(overview.data.latest_submission).includes(step));

  const last = step === STEP_COUNT - 1;
  const footer = (
    <View style={{ gap: spacing[2] }}>
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
          {error}
        </Text>
      )}
      <Button
        label={t(last ? 'kyc.tier3.send' : 'common.continue')}
        fullWidth
        disabled={!ready}
        loading={submit.isPending}
        onPress={() => {
          setError(undefined);
          if (last) send();
          else setStep(step + 1);
        }}
      />
      {step > 0 && (
        <Button
          label={t('common.back')}
          variant="ghost"
          fullWidth
          onPress={() => setStep(step - 1)}
        />
      )}
    </View>
  );

  return (
    <Screen header={header} edges={['top', 'bottom']} footer={footer}>
      <View style={{ gap: spacing[1] }}>
        <Text variant="caption" color="textMuted">
          {t('kyc.tier3.step', { step: step + 1, count: STEP_COUNT })}
        </Text>
        <Text variant="h2" accessibilityRole="header">
          {t('kyc.tier3.steps', { returnObjects: true })[step]}
        </Text>
      </View>

      {fixHere && (
        <Card variant="outline">
          <View style={[styles.fix, { gap: spacing[3] }]} accessible>
            <Icon icon={RotateCcw} color="warning" accessibilityLabel={t('kyc.tier3.toFix')} />
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="bodyStrong">{review.title}</Text>
              <Text variant="bodySmall" color="textMuted">
                {review.message}
              </Text>
            </View>
          </View>
        </Card>
      )}

      {step === 0 && (
        <>
          <View style={[styles.wrap, { gap: spacing[2] }]}>
            {(Object.keys(ID_DOCUMENTS) as IdDocument[]).map((doc) => (
              <Chip
                key={doc}
                label={ID_DOCUMENTS[doc].label}
                selected={doc === idType}
                onPress={() => setIdType(doc)}
              />
            ))}
          </View>
          <PhotoCapture kind="id_front" document={front} onUploaded={setFront} />
        </>
      )}

      {step === 1 && <PhotoCapture kind="selfie" document={selfie} onUploaded={setSelfie} />}

      {step === 2 && (
        <>
          <Card>
            <View style={{ gap: spacing[3] }}>
              <View style={styles.between}>
                <Text variant="bodyStrong">{t('kyc.tier3.fillTitle')}</Text>
                <AIBadge
                  feature={t('kyc.tier3.prefillFeature')}
                  explanation={t('kyc.tier3.prefillExplanation')}
                  fallback={t('kyc.tier3.prefillFallback')}
                />
              </View>
              {prefilled ? (
                <Text variant="bodySmall" color="textMuted">
                  {prefilled.ai.explanation}
                </Text>
              ) : (
                <>
                  <Checkbox
                    label={t('kyc.tier3.consent')}
                    checked={prefillOn}
                    onChange={(on) => setAiFeature('idPrefill', on)}
                  />
                  <Button
                    label={t('kyc.tier3.fill')}
                    icon={ScanText}
                    variant="secondary"
                    disabled={!prefillOn}
                    loading={prefill.isPending}
                    onPress={readId}
                  />
                </>
              )}
            </View>
          </Card>
          <SectionHeader title={ID_DOCUMENTS[idType].label} />
          <View style={{ gap: spacing[3] }}>
            <TextField
              label={t('kyc.tier3.idNumber')}
              help={ID_DOCUMENTS[idType].hint}
              value={idNumber}
              onChangeText={setIdNumber}
              autoCapitalize="characters"
              autoCorrect={false}
              error={numberProblem}
            />
            <TextField
              label={t('kyc.tier3.expiry')}
              optional
              placeholder={t('common.datePlaceholder')}
              keyboardType="number-pad"
              maxLength={10}
              value={expiry}
              onChangeText={(text) => setExpiry(formatDateEntry(text))}
              error={dateProblem}
            />
          </View>
        </>
      )}

      {step === 3 && (
        <>
          <Text color="textMuted">{t('kyc.tier3.addressNote')}</Text>
          <AddressFields value={address} onChange={setAddress} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  fix: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
});
