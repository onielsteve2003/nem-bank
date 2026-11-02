import type { Schema } from '@nem/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useRepositories } from '@/data';
import { usePreferencesStore } from '@/stores';

import { assistantProblem, useAssistantStore, type AssistantProblem } from './assistant';

const useHydrated = () => {
  const [hydrated, setHydrated] = useState(() => useAssistantStore.persist.hasHydrated());
  useEffect(() => useAssistantStore.persist.onFinishHydration(() => setHydrated(true)), []);
  return hydrated;
};

/**
 * The open assistant chat: reopens the last conversation (or starts one),
 * loads its whole history, and sends questions. `replyId` is the newest reply
 * that arrived while the screen was open, so only that one streams in.
 */
export function useAssistantChat() {
  const repos = useRepositories();
  const client = useQueryClient();
  const hydrated = useHydrated();
  const conversationId = useAssistantStore((s) => s.conversationId);
  const setConversationId = useAssistantStore((s) => s.setConversationId);
  const language = usePreferencesStore((s) => s.language);
  const [replyId, setReplyId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => repos.assistant.startConversation(),
    onSuccess: (c) => setConversationId(c.id),
  });

  const queryKey = ['assistant', 'listMessages', conversationId, 'all'];
  const messages = useQuery({
    queryKey,
    enabled: hydrated && conversationId !== null,
    queryFn: async () => {
      const all: Schema<'AssistantMessage'>[] = [];
      let cursor: string | null = null;
      do {
        const page = await repos.assistant.listMessages({
          path: { conversation_id: conversationId! },
          query: { limit: 100, ...(cursor ? { cursor } : {}) },
        });
        all.push(...page.data);
        cursor = page.page.next_cursor ?? null;
      } while (cursor);
      return all;
    },
  });

  // A chat the bank no longer has (a reset demo, another account) starts over.
  const gone = messages.isError && assistantProblem(messages.error) === 'gone';
  const { mutate: startChat, isIdle } = start;
  useEffect(() => {
    if (!hydrated) return;
    if (conversationId === null && isIdle) startChat();
    else if (gone) setConversationId(null);
  }, [hydrated, conversationId, gone, isIdle, startChat, setConversationId]);

  const send = useMutation({
    mutationFn: (text: string) =>
      repos.assistant.sendMessage({
        path: { conversation_id: conversationId! },
        body: { text, language },
      }),
    onMutate: (text) => setPending(text),
    onSuccess: async (reply) => {
      await client.invalidateQueries({ queryKey });
      setReplyId(reply.id);
    },
    onSettled: () => setPending(null),
  });

  const newChat = () => {
    setReplyId(null);
    start.reset();
    setConversationId(null);
  };

  const problem: AssistantProblem | null = start.isError
    ? assistantProblem(start.error)
    : messages.isError && !gone
      ? assistantProblem(messages.error)
      : null;

  return {
    messages: messages.data,
    problem,
    retry: () => (start.isError ? start.mutate() : void messages.refetch()),
    send,
    pending,
    replyId,
    newChat,
  };
}
