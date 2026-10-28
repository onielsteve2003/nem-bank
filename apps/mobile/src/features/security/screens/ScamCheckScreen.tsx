import type { Schema } from '@nem/contracts';
import * as Clipboard from 'expo-clipboard';
import { ClipboardPaste, Lock } from 'lucide-react-native';
import { useState } from 'react';
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
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoMutation } from '@/lib/query';
import { usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { guessScamKind, scamVerdict, type ScamKind } from '../security';

const KINDS: { kind: ScamKind; label: string }[] = [
  { kind: 'message', label: 'Message' },
  { kind: 'link', label: 'Link' },
  { kind: 'account_number', label: 'Account number' },
];

const PLACEHOLDER: Record<ScamKind, string> = {
  message: 'Paste the SMS, WhatsApp or email text',
  link: 'Paste the link, e.g. bit.ly/…',
  account_number: 'The 10-digit account they want you to pay',
};

const RULES_ONLY =
  'Rules only: known Nigerian scam phrases, link tricks and accounts other customers reported.';
const MAX_LENGTH = 2000;

const message = (e: unknown) => {
  if (!isApiError(e)) return 'Something went wrong. Try again.';
  if (e.problem.code === 'offline') return "You're offline. Reconnect and try again.";
  if (e.problem.status === 429) return 'You’ve checked a lot just now. Try again in a minute.';
  return e.problem.detail ?? e.problem.title;
};

function Verdict({ result }: { result: Schema<'ScamCheckResult'> }) {
  const { spacing } = useTheme();
  const aiOn = usePreferencesStore((s) => s.ai.scamChecker);
  const v = scamVerdict(result.verdict);
  return (
    <Card>
      <View style={{ gap: spacing[3] }}>
        <View
          accessible
          accessibilityRole="alert"
          style={[styles.row, { gap: spacing[2] }]}
          accessibilityLabel={`${v.label}. ${result.advice}`}
        >
          <Icon icon={v.icon} color={v.color} size="lg" />
          <Text variant="h3" style={styles.flex}>
            {v.label}
          </Text>
        </View>
        <Text variant="body">{result.advice}</Text>
        {result.reported_account === true && (
          <Text variant="bodyStrong" color="danger">
            Other customers have reported this account.
          </Text>
        )}
        {result.reported_account === false && (
          <Text variant="bodySmall" color="textMuted">
            No one has reported this account to us.
          </Text>
        )}
        <RiskReasonList
          title="What we noticed"
          reasons={result.reasons.map((r) => ({
            code: r.code,
            label: r.message,
            severity: r.severity,
          }))}
        />
        {aiOn ? (
          <View style={styles.start}>
            <AIBadge
              feature="Scam checker"
              explanation={result.ai.explanation}
              fallback={RULES_ONLY}
            />
          </View>
        ) : (
          <Text variant="caption" color="textMuted">
            AI scam checker is off · rules only
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
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ScamKind>('message');
  /** Once the customer picks a kind, stop guessing it from the text. */
  const [picked, setPicked] = useState(false);
  const [error, setError] = useState<string>();
  const check = useRepoMutation('security', 'checkScam', { invalidates: [] });
  const result = check.data;

  const change = (next: string) => {
    setText(next);
    setError(undefined);
    check.reset();
    if (!picked && next.trim()) setKind(guessScamKind(next));
  };

  const paste = async () => {
    const pasted = await Clipboard.getStringAsync().catch(() => '');
    if (pasted) change(pasted.slice(0, MAX_LENGTH));
  };

  const run = () => {
    const content = text.trim();
    if (!content) {
      setError('Paste or type what you want checked');
      return;
    }
    if (kind === 'account_number' && content.replace(/\D/g, '').length !== 10) {
      setError('Enter a 10-digit account number');
      return;
    }
    check.mutate({ body: { kind, content } }, { onError: (e) => setError(message(e)) });
  };

  return (
    <Screen
      header={<SendHeader title="Scam checker" />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label="Check it"
          size="lg"
          loading={check.isPending}
          disabled={!text.trim()}
          onPress={run}
        />
      }
    >
      <Text variant="bodySmall" color="textMuted">
        Got a message asking for money, a code or a click? Check it before you do anything.
      </Text>
      <View style={[styles.chips, { gap: spacing[2] }]}>
        {KINDS.map((k) => (
          <Chip
            key={k.kind}
            label={k.label}
            selected={kind === k.kind}
            onPress={() => {
              setPicked(true);
              setKind(k.kind);
              setError(undefined);
              check.reset();
            }}
          />
        ))}
      </View>
      <TextField
        label="What do you want checked?"
        placeholder={PLACEHOLDER[kind]}
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
        <Button label="Paste" icon={ClipboardPaste} variant="secondary" size="sm" onPress={paste} />
        {text.length > 0 && (
          <Button label="Clear" variant="ghost" size="sm" onPress={() => change('')} />
        )}
      </View>
      {result && <Verdict result={result} />}
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Icon icon={Lock} size="sm" color="textMuted" />
        <Text variant="caption" color="textMuted" style={styles.flex}>
          We check it and throw it away. It’s never stored or sent to a chatbot.
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
