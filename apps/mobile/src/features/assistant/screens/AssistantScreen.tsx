import { useRouter } from 'expo-router';
import {
  ArrowLeftRight,
  Bot,
  ChartPie,
  CreditCard,
  Send,
  SquarePen,
  Wallet,
  X,
} from 'lucide-react-native';
import { useState } from 'react';
import { FlatList, StyleSheet, TextInput, View } from 'react-native';

import {
  AIBadge,
  Card,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  IconButton,
  ListItem,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  TypingIndicator,
  useToast,
} from '@/components';
import { useTheme } from '@/theme';

import {
  PROBLEM_MESSAGE,
  PROMPT_MAX,
  SUGGESTIONS,
  assistantProblem,
  type AssistantMessage,
} from '../assistant';
import { AssistantBubble } from '../components/AssistantBubble';
import { useAssistantChat } from '../useAssistantChat';

const EXPLANATION =
  'Answers questions about your money and prepares payments. It never moves money: you check and approve each one with your PIN or Face ID.';
const FALLBACK = 'The shortcuts below: balance, spending, send money and card controls.';

/** The non-AI way to everything the assistant does (AI-6 fallback). */
function Shortcuts() {
  const router = useRouter();
  const rows = [
    { title: 'See my balance', icon: Wallet, go: () => router.dismissTo('/') },
    { title: 'My spending', icon: ChartPie, go: () => router.push('/insights') },
    { title: 'Send money', icon: ArrowLeftRight, go: () => router.push('/send') },
    { title: 'Card controls', icon: CreditCard, go: () => router.dismissTo('/cards') },
  ];
  return (
    <Card padded={false}>
      {rows.map((r, i) => (
        <View key={r.title}>
          {i > 0 && <Divider />}
          <ListItem title={r.title} leading={r.icon} onPress={r.go} />
        </View>
      ))}
    </Card>
  );
}

/**
 * Nem Assistant (AI-6): ask about your money in plain words. Replies type
 * themselves out, starter questions get you going, and the chat is kept so
 * it is there next time. Money actions are only ever prepared.
 */
export function AssistantScreen() {
  const router = useRouter();
  const toast = useToast();
  const { colors, radius, spacing, type } = useTheme();
  const chat = useAssistantChat();
  const [text, setText] = useState('');

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || chat.send.isPending) return;
    setText('');
    chat.send.mutate(q, {
      onError: (e) => {
        // What you asked goes back in the box so you can try again.
        setText(q);
        toast.show({ message: PROBLEM_MESSAGE[assistantProblem(e)], tone: 'error' });
      },
    });
  };

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[1] }]}>
      <Text variant="title" accessibilityRole="header" style={styles.flex}>
        Nem Assistant
      </Text>
      <AIBadge
        feature="Nem Assistant"
        explanation={EXPLANATION}
        fallback={FALLBACK}
        onManage={() =>
          router.push({ pathname: '/ai/[feature]', params: { feature: 'assistant' } })
        }
      />
      <IconButton
        icon={SquarePen}
        variant="ghost"
        accessibilityLabel="New chat"
        disabled={!chat.messages || chat.send.isPending}
        onPress={chat.newChat}
      />
      <IconButton
        icon={X}
        variant="ghost"
        accessibilityLabel="Close"
        onPress={() => router.back()}
      />
    </View>
  );

  if (chat.problem === 'off') {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Bot}
          title="The assistant is off"
          message="Turn it on in AI and your data, or use the shortcuts."
          actionLabel="AI and your data"
          onAction={() =>
            router.push({ pathname: '/ai/[feature]', params: { feature: 'assistant' } })
          }
        />
        <Shortcuts />
      </Screen>
    );
  }
  if (chat.problem === 'unavailable') {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <Text variant="body">{PROBLEM_MESSAGE.unavailable}</Text>
        <Shortcuts />
      </Screen>
    );
  }
  if (chat.problem) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <ErrorState title={PROBLEM_MESSAGE[chat.problem]} onRetry={chat.retry} />
      </Screen>
    );
  }
  if (!chat.messages) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel="Opening the assistant">
          <Skeleton height={64} />
          <Skeleton height={48} />
        </SkeletonGroup>
      </Screen>
    );
  }

  const asked = chat.messages.some((m) => m.role === 'user') || chat.pending !== null;
  const shown: AssistantMessage[] = [...chat.messages].reverse();
  const pendingBubble: AssistantMessage | null = chat.pending
    ? {
        id: 'pending',
        role: 'user',
        blocks: [{ type: 'text', text: chat.pending }],
        created_at: new Date().toISOString(),
      }
    : null;

  const composer = (
    <View style={{ gap: spacing[2] }}>
      {!asked && (
        <View style={[styles.wrap, { gap: spacing[2] }]} accessibilityLabel="Suggestions">
          {SUGGESTIONS.map((s) => (
            <Chip key={s} label={s} onPress={() => ask(s)} />
          ))}
        </View>
      )}
      <View style={[styles.row, styles.end, { gap: spacing[1] }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Ask about your money"
          accessibilityLabel="Ask the assistant"
          placeholderTextColor={colors.textMuted}
          selectionColor={colors.primaryText}
          maxLength={PROMPT_MAX}
          maxFontSizeMultiplier={2}
          multiline
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
          accessibilityLabel="Ask"
          disabled={!text.trim() || chat.send.isPending}
          onPress={() => ask(text)}
        />
      </View>
      <Text variant="caption" color="textMuted" style={styles.center}>
        Answers can be wrong. Nem never moves money without your PIN or Face ID.
      </Text>
    </View>
  );

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
        data={pendingBubble ? [pendingBubble, ...shown] : shown}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <AssistantBubble message={item} stream={item.id === chat.replyId} />
        )}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ padding: spacing[4], gap: spacing[3] }}
        // Inverted, so the header sits under the newest message.
        ListHeaderComponent={
          chat.send.isPending ? <TypingIndicator name="Nem Assistant" /> : undefined
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  end: { alignItems: 'flex-end' },
  flex: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  center: { textAlign: 'center' },
  input: { flex: 1, minHeight: 44, maxHeight: 120 },
});
