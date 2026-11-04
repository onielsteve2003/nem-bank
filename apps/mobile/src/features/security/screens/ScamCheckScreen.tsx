import type { Schema } from '@nem/contracts';
import { checkScamText } from '@nem/shared';
import * as Clipboard from 'expo-clipboard';
import { ClipboardPaste, Lock } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Button,
  Card,
  Chip,
  Icon,
  RiskReasonList,
  Screen,
  Text,
  TextField,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation } from '@/lib/query';
import { usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { guessScamKind, scamVerdict, type ScamKind } from '../security';

const KINDS: readonly ScamKind[] = ['message', 'link', 'account_number'];
const MAX_LENGTH = 2000;

/** The bank could not answer, so this phone's own rules can (messages and links only). */
const unreachable = (e: unknown) =>
  isApiError(e) && (e.problem.code === 'offline' || e.problem.status >= 500);

function checkOnPhone(content: string): Schema<'ScamCheckResult'> {
  return {
    ...checkScamText(content),
    reported_account: null,
    ai: {
      feature: 'scam_checker',
      model_version: 'rules-on-device-1',
      explanation: i18n.t('security.scam.onPhone'),
      fallback_used: true,
    },
  };
}

const message = (e: unknown) => {
  if (!isApiError(e)) return i18n.t('common.somethingWrong');
  if (e.problem.code === 'offline') return i18n.t('common.offline');
  if (e.problem.status === 429) return i18n.t('security.scam.tooMany');
  return e.problem.detail ?? e.problem.title;
};

function Verdict({ result }: { result: Schema<'ScamCheckResult'> }) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const aiOn = usePreferencesStore((s) => s.ai.scamChecker);
  const v = scamVerdict(result.verdict);
  return (
    <Card>
      <View style={{ gap: spacing[3] }}>
        <View
          accessible
          accessibilityRole="alert"
          style={[styles.row, { gap: spacing[2] }]}
          accessibilityLabel={t('security.scam.verdictLabel', {
            verdict: v.label,
            advice: result.advice,
          })}
        >
          <Icon icon={v.icon} color={v.color} size="lg" />
          <Text variant="h3" style={styles.flex}>
            {v.label}
          </Text>
        </View>
        <Text variant="body">{result.advice}</Text>
        {result.reported_account === true && (
          <Text variant="bodyStrong" color="danger">
            {t('security.scam.reported')}
          </Text>
        )}
        {result.reported_account === false && (
          <Text variant="bodySmall" color="textMuted">
            {t('security.scam.notReported')}
          </Text>
        )}
        <RiskReasonList
          title={t('security.scam.noticed')}
          reasons={result.reasons.map((r) => ({
            code: r.code,
            label: r.message,
            severity: r.severity,
          }))}
        />
        {result.ai.model_version === 'rules-on-device-1' && (
          <Text variant="caption" color="textMuted">
            {t('security.scam.offlineNote')}
          </Text>
        )}
        {aiOn ? (
          <View style={styles.start}>
            <AIBadge
              feature={t('security.scam.title')}
              explanation={result.ai.explanation}
              fallback={t('security.scam.rulesOnly')}
            />
          </View>
        ) : (
          <Text variant="caption" color="textMuted">
            {t('security.scam.aiOff')}
          </Text>
        )}
      </View>
    </Card>
  );
}

/**
 * Scam checker (SEC-6, AI-2): paste a message, link or account number and get
 * a verdict with the reasons behind it. What's pasted is checked and thrown
 * away; it's never stored or sent to a chatbot.
 */
export function ScamCheckScreen() {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ScamKind>('message');
  /** Once the customer picks a kind, stop guessing it from the text. */
  const [picked, setPicked] = useState(false);
  const [error, setError] = useState<string>();
  const check = useRepoMutation('security', 'checkScam', { invalidates: [] });
  const [onPhone, setOnPhone] = useState<Schema<'ScamCheckResult'> | null>(null);
  const result = check.data ?? onPhone;
  const reset = () => {
    check.reset();
    setOnPhone(null);
  };

  const change = (next: string) => {
    setText(next);
    setError(undefined);
    reset();
    if (!picked && next.trim()) setKind(guessScamKind(next));
  };

  const paste = async () => {
    const pasted = await Clipboard.getStringAsync().catch(() => '');
    if (pasted) change(pasted.slice(0, MAX_LENGTH));
  };

  const run = () => {
    const content = text.trim();
    if (!content) {
      setError(t('security.scam.empty'));
      return;
    }
    if (kind === 'account_number' && content.replace(/\D/g, '').length !== 10) {
      setError(t('security.scam.badAccount'));
      return;
    }
    setOnPhone(null);
    check.mutate(
      { body: { kind, content } },
      {
        onError: (e) => {
          if (kind !== 'account_number' && unreachable(e)) setOnPhone(checkOnPhone(content));
          else setError(message(e));
        },
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('security.scam.title')} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={t('security.scam.check')}
          size="lg"
          loading={check.isPending}
          disabled={!text.trim()}
          onPress={run}
        />
      }
    >
      <Text variant="bodySmall" color="textMuted">
        {t('security.scam.intro')}
      </Text>
      <View style={[styles.chips, { gap: spacing[2] }]}>
        {KINDS.map((k) => (
          <Chip
            key={k}
            label={t(`security.scam.kinds.${k}`)}
            selected={kind === k}
            onPress={() => {
              setPicked(true);
              setKind(k);
              setError(undefined);
              reset();
            }}
          />
        ))}
      </View>
      <TextField
        label={t('security.scam.field')}
        placeholder={t(`security.scam.placeholders.${kind}`)}
        value={text}
        onChangeText={change}
        multiline={kind === 'message'}
        keyboardType={kind === 'account_number' ? 'number-pad' : 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={MAX_LENGTH}
        error={error}
      />
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Button
          label={t('common.paste')}
          icon={ClipboardPaste}
          variant="secondary"
          size="sm"
          onPress={paste}
        />
        {text.length > 0 && (
          <Button label={t('common.clear')} variant="ghost" size="sm" onPress={() => change('')} />
        )}
      </View>
      {result && <Verdict result={result} />}
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Icon icon={Lock} size="sm" color="textMuted" />
        <Text variant="caption" color="textMuted" style={styles.flex}>
          {t('security.scam.privacy')}
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
  start: { alignSelf: 'flex-start' },
  flex: { flex: 1 },
});
