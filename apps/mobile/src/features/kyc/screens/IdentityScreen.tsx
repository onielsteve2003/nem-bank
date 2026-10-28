import type { Schema } from '@nem/contracts';
import { parseDisplayDate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { BadgeCheck, FlaskConical, LockKeyhole } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  FieldMessage,
  Icon,
  PaidFeatureNotice,
  Screen,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import { formatDateEntry } from '@/features/auth/signupForm';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { displayDate, ID_TYPES, identityProblem, UNLOCK_LABELS, type IdType } from '../kyc';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'We couldn’t check that number. Try again.';

/**
 * Tier 2 (KYC-2): a BVN or NIN and the date of birth on its record, checked
 * against sandbox test numbers. Real checks need a paid provider.
 */
export function IdentityScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const me = useRepoQuery('users', 'getMe');
  const overview = useRepoQuery('kyc', 'getOverview');
  // The tier changes what the whole app allows: limits, wallets, the checkup.
  const verify = useRepoMutation('kyc', 'verifyIdentity', { invalidates: [[]] });
  const [type, setType] = useState<IdType>('bvn');
  const [number, setNumber] = useState('');
  const [dob, setDob] = useState('');
  const [error, setError] = useState<string>();
  const [verified, setVerified] = useState<Schema<'IdentityVerification'>>();
  const [noticeOpen, setNoticeOpen] = useState(false);

  const id = ID_TYPES[type];
  const isoDob = parseDisplayDate(dob);
  const dobError = dob.length === 10 && !isoDob ? 'Enter a real date as DD/MM/YYYY' : undefined;
  const ready = number.length === 11 && Boolean(isoDob);

  const submit = () => {
    if (!ready || !isoDob) return;
    setError(undefined);
    verify.mutate(
      { body: { type, number, date_of_birth: isoDob } },
      {
        onSuccess: (result) => {
          const problem = identityProblem(result);
          if (problem) setError(problem);
          else setVerified(result);
        },
        onError: (e) => setError(message(e)),
      },
    );
  };

  if (verified) {
    const unlocks = overview.data?.tiers.find((t) => t.tier === 2)?.unlocks ?? [];
    return (
      <Screen header={<SendHeader title={id.label} />} edges={['top', 'bottom']}>
        <EmptyState
          icon={BadgeCheck}
          title={`You’re on Tier ${verified.tier}`}
          message={`Your ${ID_TYPES[verified.type].label} is verified and the name matches your account.${
            unlocks.length
              ? ` You now have ${unlocks.map((u) => UNLOCK_LABELS[u].toLowerCase()).join(', ')}.`
              : ''
          }`}
        />
        <Button label="Done" fullWidth onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen
      header={<SendHeader title="BVN or NIN" />}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          <Button
            label={`Verify ${id.label}`}
            fullWidth
            disabled={!ready}
            loading={verify.isPending}
            onPress={submit}
          />
          <Button
            label="Real verification"
            variant="ghost"
            fullWidth
            onPress={() => setNoticeOpen(true)}
          />
        </View>
      }
    >
      <Text color="textMuted">
        Verify one of these to reach Tier 2. We check it once and never show it again.
      </Text>
      <View style={[styles.row, { gap: spacing[2] }]} accessibilityRole="radiogroup">
        {(Object.keys(ID_TYPES) as IdType[]).map((t) => (
          <Chip
            key={t}
            label={ID_TYPES[t].label}
            selected={t === type}
            onPress={() => {
              setType(t);
              setError(undefined);
            }}
          />
        ))}
      </View>

      <View style={{ gap: spacing[3] }}>
        <TextField
          label={id.name}
          help={id.find}
          placeholder="11 digits"
          keyboardType="number-pad"
          maxLength={11}
          value={number}
          onChangeText={(text) => {
            setNumber(text.replace(/\D/g, ''));
            setError(undefined);
          }}
          autoComplete="off"
        />
        <TextField
          label="Date of birth"
          help={`As it is on your ${id.label} record.`}
          placeholder="DD/MM/YYYY"
          keyboardType="number-pad"
          maxLength={10}
          value={dob}
          onChangeText={(text) => {
            setDob(formatDateEntry(text));
            setError(undefined);
          }}
          error={dobError}
          autoComplete="birthdate-full"
        />
        {error && <FieldMessage error={error} />}
      </View>

      <Card variant="outline">
        <View style={[styles.top, { gap: spacing[3] }]}>
          <Icon icon={FlaskConical} color="info" />
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <Text variant="bodyStrong">Sandbox numbers only</Text>
            <Text variant="bodySmall" color="textMuted">
              {`Any 11 digits work except 00000000000, which is never found.${
                me.data?.date_of_birth
                  ? ` Your sandbox record has the date of birth ${displayDate(me.data.date_of_birth)}.`
                  : ''
              }`}
            </Text>
          </View>
        </View>
      </Card>
      <View style={[styles.top, { gap: spacing[2] }]}>
        <Icon icon={LockKeyhole} color="textMuted" size="sm" />
        <Text variant="caption" color="textMuted" style={styles.flex}>
          Your number is encrypted and only used to confirm who you are.
        </Text>
      </View>

      <PaidFeatureNotice
        open={noticeOpen}
        onClose={() => setNoticeOpen(false)}
        feature="identityVerification"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  top: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
});
