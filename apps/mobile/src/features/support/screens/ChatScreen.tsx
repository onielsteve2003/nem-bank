import type { Schema } from '@nem/contracts';
import { useLocalSearchParams } from 'expo-router';
import { Camera, ImagePlus, Send, X } from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, Image, Linking, StyleSheet, TextInput, View } from 'react-native';

import {
  Button,
  ErrorState,
  IconButton,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  TypingIndicator,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { pickEvidence } from '@/features/disputes/disputes';
import { formatDateTime } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { queryKeys, useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { MAX_ATTACHMENTS, MESSAGE_MAX, messageBody, useAgentTyping } from '../support';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'Something went wrong. Try again.';

function Bubble({ m }: { m: Schema<'SupportMessage'> }) {
  const { colors, radius, spacing } = useTheme();
  const mine = m.sender === 'customer';
  if (m.sender === 'system') {
    return (
      <Text variant="caption" color="textMuted" style={styles.system}>
        {m.body}
      </Text>
    );
  }
  const who = mine ? 'You' : (m.sender_name ?? 'Support');
  return (
    <View
      accessible
      accessibilityLabel={`${who}: ${m.body}. ${formatDateTime(m.created_at)}`}
      style={[styles.bubbleRow, mine && styles.mine]}
    >
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: mine ? colors.primary : colors.raised,
            borderRadius: radius.lg,
            padding: spacing[3],
            gap: spacing[2],
          },
        ]}
      >
        {!mine && (
          <Text variant="caption" color="textMuted">
            {who}
          </Text>
        )}
        {m.attachments.length > 0 && (
          <View style={[styles.wrap, { gap: spacing[1] }]}>
            {m.attachments.map((a) =>
              a.content_type === 'application/pdf' ? (
                <Text key={a.id} variant="caption">
                  {a.file_name}
                </Text>
              ) : (
                <Image
                  key={a.id}
                  source={{ uri: a.url }}
                  accessibilityLabel={a.file_name}
                  style={[styles.photo, { borderRadius: radius.md }]}
                />
              ),
            )}
          </View>
        )}
        <Text variant="body" style={mine ? { color: colors.onPrimary } : undefined} selectable>
          {m.body}
        </Text>
        <Text
          variant="caption"
          style={{ color: mine ? colors.onPrimary : colors.textMuted, opacity: mine ? 0.7 : 1 }}
        >
          {formatDateTime(m.created_at)}
        </Text>
      </View>
    </View>
  );
}

/**
 * A support chat (SUP-1): messages update live, the agent's typing shows as
 * dots, and you can send photos of a receipt or screen with your message.
 */
export function ChatScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();
  const { colors, radius, spacing, type } = useTheme();
  const path = { conversation_id: id };
  const conversation = useRepoQuery('support', 'getConversation', { path });
  const messages = useRepoQuery('support', 'listMessages', { path, query: { limit: 100 } });
  const typing = useAgentTyping(id);
  const upload = useRepoMutation('support', 'uploadAttachment', { invalidates: [] });
  const send = useRepoMutation('support', 'sendMessage', {
    invalidates: [queryKeys.domain('support')],
  });
  const [text, setText] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);

  const header = <SendHeader title={conversation.data?.subject ?? 'Chat'} />;
  if (!messages.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {messages.isError ? (
          <ErrorState title="We couldn't load this chat" onRetry={() => messages.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading your chat">
            <Skeleton height={64} />
            <Skeleton height={64} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const body = messageBody(text, photos.length);
  const full = photos.length >= MAX_ATTACHMENTS;

  const attach = async (source: 'camera' | 'library') => {
    const picked = await pickEvidence(source);
    if (picked.kind === 'photo') setPhotos((p) => [...p, picked.uri]);
    else if (picked.kind === 'denied') setCameraDenied(true);
    else if (picked.kind === 'too_large')
      toast.show({ message: 'That photo is over 5 MB. Try another.', tone: 'error' });
  };

  const submit = async () => {
    if (!body) return;
    setSending(true);
    try {
      const ids: string[] = [];
      for (const [i, file] of photos.entries()) {
        const a = await upload.mutateAsync({ body: { file, caption: `Photo ${i + 1}` } });
        ids.push(a.id);
      }
      await send.mutateAsync({
        path,
        body: { body, ...(ids.length ? { attachment_ids: ids } : {}) },
      });
      setText('');
      setPhotos([]);
    } catch (e) {
      // What you wrote stays put so you can try again.
      toast.show({ message: message(e), tone: 'error' });
    } finally {
      setSending(false);
    }
  };

  const closed = conversation.data?.status === 'resolved';
  const composer = (
    <View style={{ gap: spacing[2] }}>
      {closed && (
        <Text variant="caption" color="textMuted">
          This chat was closed. Send a message to open it again.
        </Text>
      )}
      {cameraDenied && (
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Text variant="bodySmall" color="warning" style={styles.flex}>
            Nem can’t use the camera. Allow it in Settings.
          </Text>
          <Button
            label="Open Settings"
            variant="ghost"
            size="sm"
            onPress={() => void Linking.openSettings()}
          />
        </View>
      )}
      {photos.length > 0 && (
        <View style={[styles.wrap, { gap: spacing[2] }]}>
          {photos.map((uri, i) => (
            <View key={`${i}-${uri.length}`}>
              <Image
                source={{ uri }}
                accessibilityLabel={`Photo ${i + 1} to send`}
                style={[styles.thumb, { borderRadius: radius.md }]}
              />
              <View style={styles.remove}>
                <IconButton
                  icon={X}
                  size="sm"
                  accessibilityLabel={`Remove photo ${i + 1}`}
                  disabled={sending}
                  onPress={() => setPhotos((p) => p.filter((_, j) => j !== i))}
                />
              </View>
            </View>
          ))}
        </View>
      )}
      <View style={[styles.row, { gap: spacing[1] }]}>
        <IconButton
          icon={Camera}
          variant="ghost"
          accessibilityLabel="Take a photo"
          disabled={full || sending}
          onPress={() => void attach('camera')}
        />
        <IconButton
          icon={ImagePlus}
          variant="ghost"
          accessibilityLabel="Add a photo"
          disabled={full || sending}
          onPress={() => void attach('library')}
        />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message"
          accessibilityLabel="Message"
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primaryText}
          maxLength={MESSAGE_MAX}
          maxFontSizeMultiplier={2}
          multiline
          editable={!sending}
          style={[
            type.body,
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.raised,
              borderRadius: radius.lg,
              paddingHorizontal: spacing[3],
              paddingVertical: spacing[2],
            },
          ]}
        />
        <IconButton
          icon={Send}
          accessibilityLabel="Send message"
          disabled={!body || sending}
          haptic="success"
          onPress={() => void submit()}
        />
      </View>
    </View>
  );

  const agent = conversation.data?.assigned_agent ?? null;
  return (
    <Screen
      header={header}
      footer={composer}
      scroll={false}
      padded={false}
      edges={['top', 'bottom']}
    >
      <FlatList
        inverted
        data={messages.data.data}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => <Bubble m={item} />}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
        // Inverted, so the header sits under the newest message.
        ListHeaderComponent={typing ? <TypingIndicator name={agent} /> : undefined}
        ListFooterComponent={
          <Text variant="caption" color="textMuted" style={styles.system}>
            Nem staff will never ask for your PIN, password or a code.
          </Text>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  flex: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  bubbleRow: { flexDirection: 'row' },
  mine: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%' },
  system: { textAlign: 'center' },
  photo: { width: 140, height: 140 },
  thumb: { width: 56, height: 56 },
  remove: { position: 'absolute', top: -8, right: -8 },
  input: { flex: 1, minHeight: 44, maxHeight: 120 },
});
