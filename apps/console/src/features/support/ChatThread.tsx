import { Link } from '@tanstack/react-router';
import { useState, type FormEvent, type KeyboardEvent } from 'react';

import { Badge } from '@/components/Badge';
import { ErrorState, Skeleton } from '@/components/PageState';
import { isApiError } from '@/data/errors';
import { formatDateTime } from '@/lib/dates';

import { CHAT_STATUS } from './labels';
import {
  useMessages,
  useResolveConversation,
  useSendMessage,
  type AgentConversation,
} from './useSupport';

/** Answers agents send often; picking one fills the box so it can be edited first. */
const SAVED_REPLIES: readonly { label: string; text: string }[] = [
  { label: 'Greeting', text: 'Hello, thanks for reaching out. I’m looking into this now.' },
  {
    label: 'Held transfer',
    text: 'Your transfer was held to protect you. Our fraud team reviews held transfers within 2 hours and you’ll get a notification as soon as it is released or returned.',
  },
  {
    label: 'Reversal',
    text: 'Failed transfers reverse automatically within 24 hours. If it has been longer, I’ll raise a dispute for you now.',
  },
  { label: 'Anything else?', text: 'Is there anything else I can help you with today?' },
];

type Props = {
  conversationId: string;
  /** From the inbox list; missing when the chat is outside the current filter. */
  conversation: AgentConversation | undefined;
  onResolved: () => void;
};

export function ChatThread({ conversationId, conversation, onResolved }: Props) {
  const messages = useMessages(conversationId);
  const send = useSendMessage(conversationId);
  const resolve = useResolveConversation(conversationId);
  const [draft, setDraft] = useState('');
  const status = conversation?.conversation.status;
  const resolved = status === 'resolved';
  // Pages arrive newest first; the thread reads top to bottom, oldest first.
  const thread = messages.data?.pages.flatMap((p) => p.data).reverse() ?? [];

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || send.isPending) return;
    send.mutate(body, { onSuccess: () => setDraft('') });
  };

  // Enter sends, Shift+Enter adds a line, like every chat tool agents already use.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) submit(event);
  };

  return (
    <section className="card chat" aria-label="Conversation">
      <header className="row space-between chat-header">
        <div className="stack tight">
          <h2>{conversation?.conversation.subject ?? 'Conversation'}</h2>
          {conversation && (
            <p className="row hint">
              <Link to="/customers/$userId" params={{ userId: conversation.customer.user_id }}>
                {conversation.customer.name}
              </Link>
              <span className="muted">Tier {conversation.customer.kyc_tier}</span>
              <Badge tone={CHAT_STATUS[conversation.conversation.status][1]}>
                {CHAT_STATUS[conversation.conversation.status][0]}
              </Badge>
            </p>
          )}
        </div>
        {conversation && !resolved && (
          <button
            type="button"
            className="btn"
            onClick={() => resolve.mutate(undefined, { onSuccess: onResolved })}
            disabled={resolve.isPending}
          >
            {resolve.isPending ? 'Resolving…' : 'Mark resolved'}
          </button>
        )}
      </header>
      {resolve.isError && (
        <p className="field-error" role="alert">
          {isApiError(resolve.error) ? resolve.error.message : 'Could not resolve the chat.'}
        </p>
      )}

      {messages.isPending ? (
        <div className="stack" aria-busy="true" aria-label="Loading messages">
          <Skeleton height={56} width="60%" />
          <Skeleton height={56} width="50%" />
        </div>
      ) : messages.isError ? (
        <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
      ) : (
        <div className="chat-log">
          {messages.hasNextPage && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void messages.fetchNextPage()}
              disabled={messages.isFetchingNextPage}
            >
              {messages.isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}
          <ol className="messages" aria-label="Messages" aria-live="polite">
            {thread.map((m) =>
              m.sender === 'system' ? (
                <li key={m.id} className="message-system muted hint">
                  {m.body} · {formatDateTime(m.created_at)}
                </li>
              ) : (
                <li key={m.id} className="message" data-sender={m.sender}>
                  <span className="hint muted">
                    {m.sender_name ?? (m.sender === 'agent' ? 'Agent' : 'Customer')} ·{' '}
                    {formatDateTime(m.created_at)}
                  </span>
                  <p>{m.body}</p>
                  {m.attachments.map((a) => (
                    <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="hint">
                      Attachment: {a.file_name} ({Math.round(a.size_bytes / 1000)} KB)
                    </a>
                  ))}
                  {m.sender === 'agent' && (
                    <span className="hint muted">{m.read_at ? 'Read' : 'Sent'}</span>
                  )}
                </li>
              ),
            )}
          </ol>
        </div>
      )}

      {resolved ? (
        <p className="muted hint">This chat is resolved. The customer can start a new one.</p>
      ) : (
        <form className="stack composer" onSubmit={submit}>
          <div className="row saved-replies" role="group" aria-label="Saved replies">
            {SAVED_REPLIES.map((r) => (
              <button
                key={r.label}
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => setDraft(r.text)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <label className="field">
            <span className="sr-only">Reply</span>
            <textarea
              className="input textarea"
              placeholder="Write a reply. Enter sends, Shift+Enter for a new line."
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </label>
          {send.isError && (
            <p className="field-error" role="alert">
              {isApiError(send.error) ? send.error.message : 'Could not send. Try again.'}
            </p>
          )}
          <div className="row space-between">
            <span className="muted hint">
              {conversation && !conversation.conversation.assigned_agent
                ? 'Replying assigns this chat to you.'
                : null}
            </span>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!draft.trim() || send.isPending}
            >
              {send.isPending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
