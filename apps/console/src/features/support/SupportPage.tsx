import { Link, useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { Segmented } from '@/components/Segmented';

import { ChatThread } from './ChatThread';
import { CHAT_STATUS, formatWait } from './labels';
import { useInbox, type InboxFilter } from './useSupport';

const FILTERS: readonly { value: InboxFilter; label: string }[] = [
  { value: 'active', label: 'All open' },
  { value: 'open', label: 'Needs reply' },
  { value: 'resolved', label: 'Resolved' },
];

type Props = { filter: InboxFilter; mine: boolean; selected: string | undefined };

/** The agent inbox (ADM-6): chats on the left, the open conversation on the right. */
export function SupportPage({ filter, mine, selected }: Props) {
  const navigate = useNavigate();
  const inbox = useInbox(filter, mine);
  const rows = inbox.data?.pages.flatMap((p) => p.data) ?? [];
  const current = rows.find((r) => r.conversation.id === selected);
  const go = (next: { status?: InboxFilter; mine?: boolean; c?: string }) =>
    void navigate({
      to: '/support',
      search: { status: filter, mine, ...(selected && { c: selected }), ...next },
    });

  return (
    <>
      <div className="row space-between">
        <div className="stack tight">
          <h1>Support chat</h1>
          <p className="muted">Customer chats, longest waiting first.</p>
        </div>
        <div className="row">
          <label className="row checkbox-label">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => go({ mine: e.target.checked })}
            />
            Only my chats
          </label>
          <Segmented
            label="Show chats"
            options={FILTERS}
            value={filter}
            onChange={(next) => go({ status: next })}
          />
        </div>
      </div>

      {inbox.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading chats">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={48} />
          ))}
        </div>
      ) : inbox.isError ? (
        <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />
      ) : (
        <div className="inbox">
          <nav className="card inbox-list" aria-label="Chats">
            {rows.length === 0 ? (
              <p className="muted state">
                {filter === 'resolved' ? 'No resolved chats yet.' : 'No customers waiting.'}
              </p>
            ) : (
              <ul>
                {rows.map((r) => {
                  const [label, tone] = CHAT_STATUS[r.conversation.status];
                  return (
                    <li key={r.conversation.id}>
                      <Link
                        to="/support"
                        search={{ status: filter, mine, c: r.conversation.id }}
                        className="inbox-item"
                        aria-current={r.conversation.id === selected ? 'true' : undefined}
                      >
                        <span className="row space-between">
                          <strong>{r.customer.name}</strong>
                          {r.conversation.unread_count > 0 && (
                            <span
                              className="unread"
                              aria-label={`${r.conversation.unread_count} unread`}
                            >
                              {r.conversation.unread_count}
                            </span>
                          )}
                        </span>
                        <span>{r.conversation.subject}</span>
                        <span className="row hint">
                          <Badge tone={tone}>{label}</Badge>
                          {r.waiting_minutes > 0 && (
                            <span className="muted">waiting {formatWait(r.waiting_minutes)}</span>
                          )}
                          {r.conversation.assigned_agent && (
                            <span className="muted">· {r.conversation.assigned_agent}</span>
                          )}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {inbox.hasNextPage && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void inbox.fetchNextPage()}
                disabled={inbox.isFetchingNextPage}
              >
                {inbox.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            )}
          </nav>

          {selected ? (
            <ChatThread
              key={selected}
              conversationId={selected}
              conversation={current}
              onResolved={() => go({ status: 'resolved', c: selected })}
            />
          ) : (
            <EmptyState title="Pick a chat">
              Choose a conversation on the left to read it and reply.
            </EmptyState>
          )}
        </div>
      )}
    </>
  );
}
