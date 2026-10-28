import { NEMTAG_MAX_LENGTH, parseDisplayDate } from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, KeyRound, Share2 } from 'lucide-react-native';
import { useState } from 'react';
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

const STEPS = ['About your child', 'Their @nemtag', 'What they can do', 'Check and confirm'];

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'Something went wrong. Try again.';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between} accessible accessibilityLabel={`${label}: ${value}`}>
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
        : 'Enter a real date as DD/MM/YYYY'
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
        setTagError(`Someone just took @${nemtag.tag}. Choose another.`);
        setTagInput('');
        setStep(1);
        return true;
      }
      setStepUpError(
        e instanceof StepUpNeedsPin
          ? 'Face ID isn’t set up for this here. Enter your PIN.'
          : message(e),
      );
      return false;
    }
  };

  if (created) {
    const code = formatSetupCode(created.code);
    return (
      <Screen
        header={<SendHeader title="Family" first />}
        edges={['top', 'bottom']}
        footer={<Button label="Done" fullWidth onPress={() => router.back()} />}
      >
        <View style={{ gap: spacing[2] }}>
          <Text variant="h2" accessibilityRole="header">
            {`${created.name} is on Nem`}
          </Text>
          <Text color="textMuted">
            Their account is open in kid mode. Use this code on their phone to set up their own
            login.
          </Text>
        </View>
        <Card>
          <View style={[styles.center, { gap: spacing[3] }]}>
            <Icon icon={KeyRound} color="primaryText" accessibilityLabel="Setup code" />
            <Text
              variant="h1"
              style={styles.code}
              accessibilityLabel={`Setup code ${created.code.split('').join(' ')}`}
              selectable
            >
              {code}
            </Text>
            <Text variant="caption" color="textMuted" align="center">
              {`Shown once. It works until ${formatDateTime(created.expires)}.`}
            </Text>
            <Button
              label="Share code"
              icon={Share2}
              variant="secondary"
              size="sm"
              onPress={() =>
                void Share.share({
                  message: `Your Nem setup code is ${code}. It works until ${formatDateTime(created.expires)}.`,
                })
              }
            />
          </View>
        </Card>
        <Text variant="bodySmall" color="textMuted">
          Only share it with your child. Nem will never ask you for it.
        </Text>
      </Screen>
    );
  }

  const footer = (
    <View style={{ gap: spacing[2] }}>
      <Button
        label={step === STEPS.length - 1 ? `Add ${first.trim() || 'child'}` : 'Continue'}
        fullWidth
        disabled={!ready}
        loading={create.isPending}
        onPress={() => {
          if (step === STEPS.length - 1) {
            setStepUpError(undefined);
            setConfirming(true);
          } else setStep(step + 1);
        }}
      />
      {step > 0 && (
        <Button label="Back" variant="ghost" fullWidth onPress={() => setStep(step - 1)} />
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
    <Screen header={<SendHeader title="Add a child" />} edges={['top', 'bottom']} footer={footer}>
      <View style={{ gap: spacing[1] }}>
        <Text variant="caption" color="textMuted">{`Step ${step + 1} of ${STEPS.length}`}</Text>
        <Text variant="h2" accessibilityRole="header">
          {STEPS[step]}
        </Text>
      </View>

      {step === 0 && (
        <View style={{ gap: spacing[3] }}>
          <TextField
            label="First name"
            value={first}
            onChangeText={setFirst}
            maxLength={50}
            autoCapitalize="words"
            autoCorrect={false}
          />
          <TextField
            label="Last name"
            value={last}
            onChangeText={setLast}
            maxLength={50}
            autoCapitalize="words"
            autoCorrect={false}
          />
          <TextField
            label="Date of birth"
            placeholder="DD/MM/YYYY"
            help="Children on Nem are 6 to 17"
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
          <Text color="textMuted">
            {`Friends and family can send ${first.trim()} money with it. 3 to 20 letters, numbers or _, starting with a letter.`}
          </Text>
          <TextField
            label="Their @nemtag"
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
          <Text color="textMuted">A safe start. You can change these any time.</Text>
          {preset('Most they can spend in a day', DAILY_LIMIT_PRESETS, 'daily_spend_limit')}
          {preset('Ask me before they send more than', APPROVAL_PRESETS, 'approval_threshold')}
          <Switch
            label="Let them send to other banks"
            description="Off means they can pay Nem users only."
            value={controls.can_send_to_banks}
            onValueChange={(on) => setControls({ ...controls, can_send_to_banks: on })}
          />
        </View>
      )}

      {step === 3 && (
        <>
          <Card>
            <View style={{ gap: spacing[2] }}>
              <Row label="Name" value={name} />
              <Row label="Date of birth" value={dob} />
              <Row label="@nemtag" value={`@${nemtag.tag}`} />
              <Divider />
              {controlsSummary(controls).map((line) => (
                <Text key={line} variant="bodySmall">
                  {line}
                </Text>
              ))}
            </View>
          </Card>
          <SectionHeader title="What happens next" />
          <Text variant="bodySmall" color="textMuted">
            {`${first.trim()} gets a naira account and kid mode: a simpler app with goals. You see their activity and approve bigger payments. You’ll get a one-time code to set up their login on their phone.`}
          </Text>
        </>
      )}

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={`Add ${name} to your family`}
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
