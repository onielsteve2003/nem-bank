import type { Schema } from '@nem/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AtSign, ChevronDown, Hash, Landmark, UserRound } from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import {
  Button,
  ErrorState,
  FieldMessage,
  FormField,
  Icon,
  Screen,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

import { BankPickerSheet } from '../components/BankPickerSheet';
import { PayeeCard } from '../components/PayeeCard';
import { SendHeader } from '../components/SendHeader';
import { isNuban, nemLookupQuery } from '../recipient';
import { recipientFromPayee, useSendDraft, type SendMode } from '../sendDraft';

type Bank = Schema<'Bank'>;

/** Long enough that a lookup waits for typing to pause, short enough to feel live. */
export const LOOKUP_DELAY_MS = 400;
const MIN_NAME_LENGTH = 2;

/**
 * Who to pay (TRF-1, TRF-2, TRF-3). Nem users are found by @nemtag, phone or
 * account number. For other banks the customer picks the bank, enters the
 * account number and the name they expect; the bank answers with the real
 * account name and how well the two match (Confirmation of Payee).
 */
export function RecipientScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode: SendMode = params.mode === 'bank' ? 'bank' : 'nem';
  const { colors, radius, spacing } = useTheme();
  const setRecipient = useSendDraft((s) => s.setRecipient);

  const [nemInput, setNemInput] = useState('');
  const [bank, setBank] = useState<Bank | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [accountNumber, setAccountNumber] = useState('');
  const [expectedName, setExpectedName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const nemQuery = nemLookupQuery(useDebounced(nemInput, LOOKUP_DELAY_MS));
  const settledName = useDebounced(expectedName.trim(), LOOKUP_DELAY_MS);
  const bankReady =
    bank !== null && isNuban(accountNumber) && settledName.length >= MIN_NAME_LENGTH;

  const body: Schema<'PayeeQuery'> | null =
    mode === 'nem'
      ? nemQuery
        ? { kind: 'nem', query: nemQuery }
        : null
      : bankReady
        ? {
            kind: 'bank',
            bank_code: bank.code,
            account_number: accountNumber,
            expected_name: settledName,
          }
        : null;

  const lookup = useRepoQuery(
    'payees',
    'resolve',
    { body: body! },
    // A miss is an answer ("no such account"), not a glitch to retry.
    { enabled: body !== null, retry: false, staleTime: 60_000 },
  );
  const payee = body ? lookup.data : undefined;
  const verdictBlocks = payee?.name_match?.result === 'no_match' && !acknowledged;

  const apiError = body !== null && isApiError(lookup.error) ? lookup.error : null;
  // 4xx is the bank's answer (not found, your own account); 5xx and timeouts offer a retry.
  const notFound = apiError !== null && apiError.status < 500;
  const lookupError = notFound
    ? (apiError.problem.detail ??
      (apiError.code === 'account_not_found'
        ? mode === 'nem'
          ? 'No Nem user matches that. Check the @nemtag or number.'
          : `We could not find that account at ${bank?.short_name ?? 'that bank'}.`
        : apiError.problem.title))
    : undefined;

  const goOn = () => {
    if (!payee) return;
    setRecipient(recipientFromPayee(payee));
    router.push('/send/amount');
  };

  const footer = (
    <Button
      label="Continue"
      disabled={!payee || verdictBlocks}
      onPress={goOn}
      accessibilityHint={verdictBlocks ? 'Tick the box to confirm you checked the name' : undefined}
    />
  );

  return (
    <Screen
      header={<SendHeader title={mode === 'nem' ? 'Pay a Nem user' : 'Pay another bank'} />}
      footer={footer}
      edges={['top', 'bottom']}
    >
      {mode === 'nem' ? (
        <TextField
          label="@nemtag, phone or account number"
          placeholder="@amaka_o"
          leadingIcon={AtSign}
          value={nemInput}
          onChangeText={setNemInput}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          error={lookupError}
          help={lookupError ? undefined : 'We look them up as you type.'}
        />
      ) : (
        <>
          <FormField label="Bank">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Bank, ${bank?.name ?? 'not selected'}`}
              accessibilityHint="Opens the list of banks"
              onPress={() => setPickerOpen(true)}
              style={[
                styles.picker,
                {
                  borderRadius: radius.md,
                  borderColor: colors.border,
                  backgroundColor: colors.raised,
                  paddingHorizontal: spacing[4],
                  gap: spacing[2],
                },
              ]}
            >
              <Icon icon={Landmark} color="textMuted" />
              <Text color={bank ? 'text' : 'textMuted'} style={styles.flex} numberOfLines={1}>
                {bank?.name ?? 'Choose a bank'}
              </Text>
              <Icon icon={ChevronDown} color="textMuted" />
            </Pressable>
          </FormField>
          <TextField
            label="Account number"
            placeholder="10 digits"
            leadingIcon={Hash}
            keyboardType="number-pad"
            maxLength={10}
            value={accountNumber}
            onChangeText={(t) => {
              setAccountNumber(t.replace(/\D/g, ''));
              setAcknowledged(false);
            }}
            error={lookupError}
          />
          <TextField
            label="Name on the account"
            placeholder="Who you expect to pay"
            leadingIcon={UserRound}
            autoCapitalize="words"
            autoCorrect={false}
            value={expectedName}
            onChangeText={(t) => {
              setExpectedName(t);
              setAcknowledged(false);
            }}
            help="We check it against the bank's records before you pay."
          />
        </>
      )}

      {body && lookup.isFetching && !payee && (
        <View style={[styles.row, { gap: spacing[2] }]} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.textMuted} />
          <Text color="textMuted">Looking them up…</Text>
        </View>
      )}
      {body && lookup.isError && !notFound && (
        <ErrorState title="We couldn't check that right now" onRetry={() => lookup.refetch()} />
      )}
      {mode === 'bank' && !bank && !payee && (
        <FieldMessage help="Bank transfers cost ₦10 to ₦50, shown before you confirm." />
      )}
      {payee && (
        <PayeeCard payee={payee} acknowledged={acknowledged} onAcknowledge={setAcknowledged} />
      )}

      <BankPickerSheet
        open={pickerOpen}
        selected={bank?.code ?? null}
        onClose={() => setPickerOpen(false)}
        onSelect={(b) => {
          setBank(b);
          setAcknowledged(false);
          setPickerOpen(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  picker: { flexDirection: 'row', alignItems: 'center', minHeight: 52, borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
