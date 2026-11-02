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
import { useTranslation } from 'react-i18next';
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
  assistantProblem,
  suggestions,
  type AssistantMessage,
} from '../assistant';
import { AssistantBubble } from '../components/AssistantBubble';
import { useAssistantChat } from '../useAssistantChat';

/** The non-AI way to everything the assistant does (AI-6 fallback). */
function Shortcuts() {
  const router = useRouter();
  const { t } = useTranslation();
  const rows = [
    { title: t('assistant.shortcuts.balance'), icon: Wallet, go: () => router.dismissTo('/') },
    {
      title: t('assistant.shortcuts.spending'),
      icon: ChartPie,
      go: () => router.push('/insights'),
    },
    { title: t('assistant.shortcuts.send'), icon: ArrowLeftRight, go: () => router.push('/send') },
    {
      title: t('assistant.shortcuts.cards'),
      icon: CreditCard,
      go: () => router.dismissTo('/cards'),
    },
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
  const { t } = useTranslation();
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
        {t('assistant.name')}
      </Text>
      <AIBadge
        feature={t('assistant.name')}
        explanation={t('assistant.explanation')}
        fallback={t('assistant.fallback')}
        onManage={() =>
          router.push({ pathname: '/ai/[feature]', params: { feature: 'assistant' } })
        }
      />
      <IconButton
        icon={SquarePen}
        variant="ghost"
        accessibilityLabel={t('assistant.newChat')}
        disabled={!chat.messages || chat.send.isPending}
        onPress={chat.newChat}
      />
      <IconButton
        icon={X}
        variant="ghost"
        accessibilityLabel={t('common.close')}
        onPress={() => router.back()}
      />
    </View>
  );

  if (chat.problem === 'off') {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Bot}
          title={t('assistant.offTitle')}
          message={t('assistant.offMessage')}
          actionLabel={t('ai.transparency.title')}
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
        <SkeletonGroup accessibilityLabel={t('assistant.opening')}>
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
        <View
          style={[styles.wrap, { gap: spacing[2] }]}
          accessibilityLabel={t('assistant.suggestionsLabel')}
        >
          {suggestions().map((s) => (
            <Chip key={s} label={s} onPress={() => ask(s)} />
          ))}
        </View>
      )}
      <View style={[styles.row, styles.end, { gap: spacing[1] }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t('assistant.placeholder')}
          accessibilityLabel={t('assistant.inputLabel')}
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
          accessibilityLabel={t('assistant.ask')}
          disabled={!text.trim() || chat.send.isPending}
          onPress={() => ask(text)}
        />
      </View>
      <Text variant="caption" color="textMuted" style={styles.center}>
        {t('assistant.disclaimer')}
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
          chat.send.isPending ? <TypingIndicator name={t('assistant.name')} /> : undefined
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
