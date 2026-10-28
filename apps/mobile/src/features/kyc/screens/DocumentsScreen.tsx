import type { Schema } from '@nem/contracts';
import { parseDisplayDate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Clock, ScanText, ShieldAlert } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  ErrorState,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
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
  type IdDocument,
} from '../kyc';

type Doc = Schema<'KycDocument'>;
const STEPS = ['Your ID', 'Selfie', 'ID details', 'Address'] as const;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'We couldn’t send that. Try again.';

const usable = (d: Doc | undefined): d is Doc => Boolean(d && !photoProblem(d));

/**
 * Tier 3 (KYC-3, KYC-4): a photo of a government ID, a selfie, the ID's
 * details (optionally read from the photo by AI, with consent) and an address,
 * then off to a reviewer.
 */
export function DocumentsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
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

  const header = <SendHeader title="Tier 3" />;
  if (!overview.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {overview.isError ? (
          <ErrorState
            title="We couldn't load your verification"
            onRetry={() => overview.refetch()}
          />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading">
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
          title="We’re checking your documents"
          message="This usually takes a few minutes. We’ll tell you as soon as you’re on Tier 3."
        />
        <Button label="Done" fullWidth onPress={() => router.back()} />
      </Screen>
    );
  }

  if (overview.data.tier < 2) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={ShieldAlert}
          title="Verify your BVN or NIN first"
          message="Tier 3 builds on Tier 2."
          actionLabel="Verify BVN or NIN"
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

  const last = step === STEPS.length - 1;
  const footer = (
    <View style={{ gap: spacing[2] }}>
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
          {error}
        </Text>
      )}
      <Button
        label={last ? 'Send for review' : 'Continue'}
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
        <Button label="Back" variant="ghost" fullWidth onPress={() => setStep(step - 1)} />
      )}
    </View>
  );

  return (
    <Screen header={header} edges={['top', 'bottom']} footer={footer}>
      <View style={{ gap: spacing[1] }}>
        <Text variant="caption" color="textMuted">{`Step ${step + 1} of ${STEPS.length}`}</Text>
        <Text variant="h2" accessibilityRole="header">
          {STEPS[step]}
        </Text>
      </View>

      {step === 0 && (
        <>
          <View style={[styles.wrap, { gap: spacing[2] }]}>
            {(Object.keys(ID_DOCUMENTS) as IdDocument[]).map((t) => (
              <Chip
                key={t}
                label={ID_DOCUMENTS[t].label}
                selected={t === idType}
                onPress={() => setIdType(t)}
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
                <Text variant="bodyStrong">Fill from your ID photo</Text>
                <AIBadge
                  feature="ID prefill"
                  explanation="Reads the type, number and expiry date from the photo of your ID. Nothing is sent until you agree, and you check every field before it goes."
                  fallback="Type the details yourself."
                />
              </View>
              {prefilled ? (
                <Text variant="bodySmall" color="textMuted">
                  {prefilled.ai.explanation}
                </Text>
              ) : (
                <>
                  <Checkbox
                    label="Let Nem read my ID photo to fill these in"
                    checked={prefillOn}
                    onChange={(on) => setAiFeature('idPrefill', on)}
                  />
                  <Button
                    label="Fill from photo"
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
              label="ID number"
              help={ID_DOCUMENTS[idType].hint}
              value={idNumber}
              onChangeText={setIdNumber}
              autoCapitalize="characters"
              autoCorrect={false}
              error={numberProblem}
            />
            <TextField
              label="Expiry date"
              optional
              placeholder="DD/MM/YYYY"
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
          <Text color="textMuted">Where you live now. It doesn’t have to match your ID.</Text>
          <AddressFields value={address} onChange={setAddress} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
});
