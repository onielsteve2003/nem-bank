import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, Screen, SectionHeader, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { queryKeys, useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { MESSAGE_MAX, SUBJECT_MAX, TOPICS } from '../support';

const OTHER = 'Something else';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'Something went wrong. Try again.';

/** Starting a support chat (SUP-1): what it's about and your first message. */
export function NewChatScreen() {
  const { transaction } = useLocalSearchParams<{ transaction?: string }>();
  const router = useRouter();
  const { spacing } = useTheme();
  const start = useRepoMutation('support', 'startConversation', {
    invalidates: [queryKeys.domain('support')],
  });
  const [topic, setTopic] = useState<string>(transaction ? 'A transfer' : '');
  const [custom, setCustom] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const subject = (topic === OTHER ? custom : topic).trim();
  const ready = subject.length > 0 && text.trim().length > 0;

  const send = () => {
    setError(undefined);
    start.mutate(
      {
        body: {
          subject,
          message: text.trim(),
          ...(transaction ? { transaction_id: transaction } : {}),
        },
      },
      {
        onSuccess: (c) => router.replace({ pathname: '/support/[id]', params: { id: c.id } }),
        onError: (e) => setError(message(e)),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title="New chat" />}
      footer={
        <Button label="Send" disabled={!ready} loading={start.isPending} onPress={send} fullWidth />
      }
      edges={['top', 'bottom']}
    >
      <View style={{ gap: spacing[3] }}>
        <SectionHeader title="What's it about?" />
        <View style={[styles.wrap, { gap: spacing[2] }]}>
          {[...TOPICS, OTHER].map((t) => (
            <Chip key={t} label={t} selected={topic === t} onPress={() => setTopic(t)} />
          ))}
        </View>
        {topic === OTHER && (
          <TextField
            label="Subject"
            value={custom}
            onChangeText={setCustom}
            maxLength={SUBJECT_MAX}
            placeholder="A few words"
          />
        )}
      </View>
      <TextField
        label="Your message"
        value={text}
        onChangeText={setText}
        multiline
        maxLength={MESSAGE_MAX}
        placeholder="Tell us what happened. Never share your PIN or password."
        help={transaction ? 'We’ll attach the payment you came from.' : undefined}
      />
      <Text variant="caption" color="textMuted">
        Our team replies here, usually within minutes. Nem staff will never ask for your PIN,
        password or a code.
      </Text>
      {error && (
        <Text variant="bodySmall" color="danger">
          {error}
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
