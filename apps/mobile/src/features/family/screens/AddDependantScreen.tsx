import { NEMTAG_MAX_LENGTH, parseDisplayDate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, KeyRound, Share2 } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Chip,
  Divider,
  Icon,
  Screen,
  SectionHeader,
  Switch,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import { NemtagStatusLine } from '@/features/auth/components/NemtagStatusLine';
import { formatDateEntry } from '@/features/auth/signupForm';
import { useNemtagCheck } from '@/features/auth/useNemtagCheck';
import {
  StepUpCancelled,
  StepUpNeedsPin,
  useStepUp,
  type StepUpProof,
} from '@/features/cards/hooks/useStepUp';
import { formatDateTime } from '@/features/transactions/format';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { toApiMoney } from '@/lib/money';
import { queryKeys, useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import {
  APPROVAL_PRESETS,
  controlsSummary,
  DAILY_LIMIT_PRESETS,
  DEFAULT_CONTROLS,
  dependantAgeProblem,
  formatSetupCode,
  nairaText,
  type Controls,
} from '../family';

const STEP_COUNT = 4;

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('common.somethingWrong');

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={styles.between}
      accessible
      accessibilityLabel={i18n.t('kyc.tiers.fact', { label, value })}
    >
      <Text variant="bodySmall" color="textMuted">
        {label}
      </Text>
      <Text variant="bodySmall" style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Adding a dependant (FAM-1): who they are, the @nemtag friends pay them on,
 * their starting limits, then your PIN or Face ID. The bank answers with a
 * one-time code that sets up their own login on their phone.
 */
export function AddDependantScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const stepUp = useStepUp();
  const create = useRepoMutation('family', 'createDependant', {
    invalidates: [queryKeys.domain('family')],
  });

  const [step, setStep] = useState(0);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [dob, setDob] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [confirming, setConfirming] = useState(false);
  const [stepUpError, setStepUpError] = useState<string>();
  const [tagError, setTagError] = useState<string>();
  const [created, setCreated] = useState<{ name: string; code: string; expires: string }>();

  const nemtag = useNemtagCheck(tagInput);
  const isoDob = parseDisplayDate(dob);
  const dobProblem =
    dob.length === 10
      ? isoDob
        ? dependantAgeProblem(isoDob, new Date())
        : t('common.dateInvalid')
      : undefined;
  const detailsReady = Boolean(first.trim() && last.trim() && isoDob && !dobProblem);
  const ready = [detailsReady, nemtag.available, true, true][step];
  const name = `${first.trim()} ${last.trim()}`;

  const approve = async (proof: StepUpProof) => {
    if (!isoDob) return false;
    setStepUpError(undefined);
    try {
      const stepUpToken = await stepUp('new_beneficiary', 'family', proof);
      const result = await create.mutateAsync({
        body: {
          first_name: first.trim(),
          last_name: last.trim(),
          date_of_birth: isoDob,
          nemtag: nemtag.tag,
          controls,
        },
        stepUpToken,
      });
      setCreated({
        name: first.trim(),
        code: result.setup_code,
        expires: result.setup_code_expires_at,
      });
      setConfirming(false);
      return true;
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      if (isApiError(e) && e.problem.code === 'nemtag_taken') {
        // Someone took the tag while you were deciding: choose another.
        setConfirming(false);
        setTagError(t('family.add.taken', { tag: nemtag.tag }));
        setTagInput('');
        setStep(1);
        return true;
      }
      setStepUpError(e instanceof StepUpNeedsPin ? t('common.faceIdUsePin') : message(e));
      return false;
    }
  };

  if (created) {
    const code = formatSetupCode(created.code);
    return (
      <Screen
        header={<SendHeader title={t('family.title')} first />}
        edges={['top', 'bottom']}
        footer={<Button label={t('common.done')} fullWidth onPress={() => router.back()} />}
      >
        <View style={{ gap: spacing[2] }}>
          <Text variant="h2" accessibilityRole="header">
            {t('family.add.onNem', { name: created.name })}
          </Text>
          <Text color="textMuted">{t('family.add.kidMode')}</Text>
        </View>
        <Card>
          <View style={[styles.center, { gap: spacing[3] }]}>
            <Icon
              icon={KeyRound}
              color="primaryText"
              accessibilityLabel={t('family.add.setupCode')}
            />
            <Text
              variant="h1"
              style={styles.code}
              accessibilityLabel={t('family.add.codeLabel', {
                code: created.code.split('').join(' '),
              })}
              selectable
            >
              {code}
            </Text>
            <Text variant="caption" color="textMuted" align="center">
              {t('family.add.shownOnce', { when: formatDateTime(created.expires) })}
            </Text>
            <Button
              label={t('family.add.share')}
              icon={Share2}
              variant="secondary"
              size="sm"
              onPress={() =>
                void Share.share({
                  message: t('family.add.shareMessage', {
                    code,
                    when: formatDateTime(created.expires),
                  }),
                })
              }
            />
          </View>
        </Card>
        <Text variant="bodySmall" color="textMuted">
          {t('family.add.onlyChild')}
        </Text>
      </Screen>
    );
  }

  const footer = (
    <View style={{ gap: spacing[2] }}>
      <Button
        label={
          step === STEP_COUNT - 1
            ? t('family.add.addName', { name: first.trim() || t('family.add.child') })
            : t('common.continue')
        }
        fullWidth
        disabled={!ready}
        loading={create.isPending}
        onPress={() => {
          if (step === STEP_COUNT - 1) {
            setStepUpError(undefined);
            setConfirming(true);
          } else setStep(step + 1);
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

  const preset = (
    label: string,
    options: typeof DAILY_LIMIT_PRESETS,
    key: 'daily_spend_limit' | 'approval_threshold',
  ) => (
    <View style={{ gap: spacing[2] }}>
      <Text variant="label" color="textMuted">
        {label}
      </Text>
      <View style={[styles.wrap, { gap: spacing[2] }]}>
        {options.map((m) => {
          const value = toApiMoney(m);
          return (
            <Chip
              key={value.amount_minor}
              label={nairaText(value)}
              selected={controls[key].amount_minor === value.amount_minor}
              onPress={() => setControls({ ...controls, [key]: value })}
            />
          );
        })}
      </View>
    </View>
  );

  return (
    <Screen
      header={<SendHeader title={t('family.add.title')} />}
      edges={['top', 'bottom']}
      footer={footer}
    >
      <View style={{ gap: spacing[1] }}>
        <Text variant="caption" color="textMuted">
          {t('kyc.tier3.step', { step: step + 1, count: STEP_COUNT })}
        </Text>
        <Text variant="h2" accessibilityRole="header">
          {t('family.add.steps', { returnObjects: true })[step]}
        </Text>
      </View>

      {step === 0 && (
        <View style={{ gap: spacing[3] }}>
          <TextField
            label={t('common.firstName')}
            value={first}
            onChangeText={setFirst}
            maxLength={50}
            autoCapitalize="words"
            autoCorrect={false}
          />
          <TextField
            label={t('common.lastName')}
            value={last}
            onChangeText={setLast}
            maxLength={50}
            autoCapitalize="words"
            autoCorrect={false}
          />
          <TextField
            label={t('common.dateOfBirth')}
            placeholder={t('common.datePlaceholder')}
            help={t('family.add.ageHelp')}
            keyboardType="number-pad"
            maxLength={10}
            value={dob}
            onChangeText={(text) => setDob(formatDateEntry(text))}
            error={dobProblem}
          />
        </View>
      )}

      {step === 1 && (
        <View style={{ gap: spacing[3] }}>
          <Text color="textMuted">{t('family.add.tagIntro', { name: first.trim() })}</Text>
          <TextField
            label={t('family.add.theirTag')}
            leadingIcon={AtSign}
            value={tagInput}
            onChangeText={(text) => {
              setTagInput(text);
              setTagError(undefined);
            }}
            error={tagError}
            maxLength={NEMTAG_MAX_LENGTH + 1}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {nemtag.status && <NemtagStatusLine status={nemtag.status} checking={nemtag.checking} />}
          {nemtag.suggestions.length > 0 && (
            <View style={[styles.wrap, { gap: spacing[2] }]}>
              {nemtag.suggestions.map((idea) => (
                <Button
                  key={idea}
                  label={`@${idea}`}
                  variant="secondary"
                  size="sm"
                  onPress={() => setTagInput(idea)}
                />
              ))}
            </View>
          )}
        </View>
      )}

      {step === 2 && (
        <View style={{ gap: spacing[4] }}>
          <Text color="textMuted">{t('family.add.safeStart')}</Text>
          {preset(t('family.add.mostPerDay'), DAILY_LIMIT_PRESETS, 'daily_spend_limit')}
          {preset(t('family.add.askBefore'), APPROVAL_PRESETS, 'approval_threshold')}
          <Switch
            label={t('family.add.letBanks')}
            description={t('family.add.letBanksHelp')}
            value={controls.can_send_to_banks}
            onValueChange={(on) => setControls({ ...controls, can_send_to_banks: on })}
          />
        </View>
      )}

      {step === 3 && (
        <>
          <Card>
            <View style={{ gap: spacing[2] }}>
              <Row label={t('common.name')} value={name} />
              <Row label={t('common.dateOfBirth')} value={dob} />
              <Row label={t('profile.nemtag')} value={`@${nemtag.tag}`} />
              <Divider />
              {controlsSummary(controls).map((line) => (
                <Text key={line} variant="bodySmall">
                  {line}
                </Text>
              ))}
            </View>
          </Card>
          <SectionHeader title={t('family.add.next')} />
          <Text variant="bodySmall" color="textMuted">
            {t('family.add.nextBody', { name: first.trim() })}
          </Text>
        </>
      )}

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={t('family.add.confirm', { name })}
        error={stepUpError}
        onApproved={(pin) => (pin ? approve({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => approve({ biometric: label })}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  center: { alignItems: 'center' },
  code: { letterSpacing: 4, fontVariant: ['tabular-nums'] },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  value: { flexShrink: 1, textAlign: 'right' },
});
