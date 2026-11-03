import type { Schema } from '@nem/contracts';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';

import { useRepositories } from '@/data/provider';

export type AgentConversation = Schema<'AgentConversation'>;
export type SupportMessage = Schema<'SupportMessage'>;
/** `active` = open or waiting on the customer: not yet resolved. */
export type InboxFilter = 'active' | 'open' | 'resolved';

/** How often an open chat checks for new messages until realtime arrives in Phase 2. */
const LIVE_POLL_MS = 5_000;

export const supportKeys = {
  inbox: (filter: InboxFilter, mine: boolean) => ['support', 'inbox', filter, mine] as const,
  messages: (id: string) => ['support', 'messages', id] as const,
};

export function useInbox(filter: InboxFilter, mine: boolean) {
  const { support } = useRepositories();
  return useInfiniteQuery({
    queryKey: supportKeys.inbox(filter, mine),
    queryFn: ({ pageParam, signal }) =>
      support.listConversations(
        {
          query: {
            ...(filter !== 'active' && { status: filter }),
            ...(mine && { assigned_to_me: true }),
            cursor: pageParam,
          },
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_POLL_MS * 6,
  });
}

/** Pages come newest first; "load earlier" fetches the next page back in time. */
export function useMessages(conversationId: string) {
  const { support } = useRepositories();
  return useInfiniteQuery({
    queryKey: supportKeys.messages(conversationId),
    queryFn: ({ pageParam, signal }) =>
      support.listMessages(
        { path: { conversation_id: conversationId }, query: { cursor: pageParam } },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.page.next_cursor ?? undefined,
    refetchInterval: LIVE_POLL_MS,
  });
}

export function useSendMessage(conversationId: string) {
  const { support } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      support.sendMessage({ path: { conversation_id: conversationId }, body: { body } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.messages(conversationId) });
      void queryClient.invalidateQueries({ queryKey: ['support', 'inbox'] });
    },
  });
}

export function useResolveConversation(conversationId: string) {
  const { support } = useRepositories();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => support.resolve({ path: { conversation_id: conversationId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['support'] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}
