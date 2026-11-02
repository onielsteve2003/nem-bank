import type { Schema } from '@nem/contracts';
import { parseDisplayDate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { BadgeCheck, FlaskConical, LockKeyhole } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import i18n from '@/lib/i18n';
import { formatDateEntry } from '@/features/auth/signupForm';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { displayDate, ID_TYPES, identityProblem, UNLOCK_LABELS, type IdType } from '../kyc';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('kyc.tier2.checkFailed');

/**
 * Tier 2 (KYC-2): a BVN or NIN and the date of birth on its record, checked
 * against sandbox test numbers. Real checks need a paid provider.
 */
export function IdentityScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
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
  const dobError = dob.length === 10 && !isoDob ? t('common.dateInvalid') : undefined;
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
          title={t('kyc.tier2.onTier', { tier: verified.tier })}
          message={
            t('kyc.tier2.verified', { label: ID_TYPES[verified.type].label }) +
            (unlocks.length
              ? t('kyc.tier2.nowHave', {
                  unlocks: unlocks.map((u) => UNLOCK_LABELS[u].toLowerCase()).join(', '),
                })
              : '')
          }
        />
        <Button label={t('common.done')} fullWidth onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('kyc.tier2.title')} />}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          <Button
            label={t('kyc.tier2.verify', { label: id.label })}
            fullWidth
            disabled={!ready}
            loading={verify.isPending}
            onPress={submit}
          />
          <Button
            label={t('kyc.tier2.real')}
            variant="ghost"
            fullWidth
            onPress={() => setNoticeOpen(true)}
          />
        </View>
      }
    >
      <Text color="textMuted">{t('kyc.tier2.intro')}</Text>
      <View style={[styles.row, { gap: spacing[2] }]} accessibilityRole="radiogroup">
        {(Object.keys(ID_TYPES) as IdType[]).map((option) => (
          <Chip
            key={option}
            label={ID_TYPES[option].label}
            selected={option === type}
            onPress={() => {
              setType(option);
              setError(undefined);
            }}
          />
        ))}
      </View>

      <View style={{ gap: spacing[3] }}>
        <TextField
          label={id.name}
          help={id.find}
          placeholder={t('kyc.tier2.digits')}
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
          label={t('common.dateOfBirth')}
          help={t('kyc.tier2.dobHelp', { label: id.label })}
          placeholder={t('common.datePlaceholder')}
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
            <Text variant="bodyStrong">{t('kyc.tier2.sandbox')}</Text>
            <Text variant="bodySmall" color="textMuted">
              {t('kyc.tier2.sandboxHelp') +
                (me.data?.date_of_birth
                  ? t('kyc.tier2.sandboxDob', { date: displayDate(me.data.date_of_birth) })
                  : '')}
            </Text>
          </View>
        </View>
      </Card>
      <View style={[styles.top, { gap: spacing[2] }]}>
        <Icon icon={LockKeyhole} color="textMuted" size="sm" />
        <Text variant="caption" color="textMuted" style={styles.flex}>
          {t('kyc.tier2.encrypted')}
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
