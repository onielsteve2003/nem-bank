-- name: CreateConversation :one
INSERT INTO assistant_conversations (id, user_id) VALUES (@id, @user_id) RETURNING *;

-- name: GetConversation :one
SELECT * FROM assistant_conversations WHERE id = @id AND user_id = @user_id;

-- name: InsertMessage :one
INSERT INTO assistant_messages (id, conversation_id, user_id, role, blocks, ai, provider)
VALUES (@id, @conversation_id, @user_id, @role, @blocks, sqlc.narg('ai'), sqlc.narg('provider'))
RETURNING *;

-- name: ListMessages :many
-- Oldest first, keyset paged on (created_at, id).
SELECT * FROM assistant_messages
WHERE conversation_id = @conversation_id AND user_id = @user_id
  AND (created_at, id) > (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at, id
LIMIT @lim;

-- name: RecentMessages :many
-- The last few messages, newest first: what the model is reminded of.
SELECT * FROM assistant_messages
WHERE conversation_id = @conversation_id AND user_id = @user_id
ORDER BY created_at DESC, id DESC
LIMIT @lim;

-- name: CountSentSince :one
-- The customer's own messages since a time (the per-minute and per-day caps).
SELECT count(*)::bigint FROM assistant_messages
WHERE user_id = @user_id AND role = 'user' AND created_at >= @since;

-- name: CountInConversation :one
SELECT count(*)::bigint FROM assistant_messages
WHERE conversation_id = @conversation_id AND user_id = @user_id AND role = 'user';

-- name: InsertAction :one
INSERT INTO prepared_actions (id, user_id, conversation_id, kind, summary, details, expires_at)
VALUES (@id, @user_id, @conversation_id, @kind, @summary, @details, @expires_at)
RETURNING *;

-- name: GetAction :one
SELECT * FROM prepared_actions WHERE id = @id AND user_id = @user_id;

-- name: CountPendingActions :one
SELECT count(*)::bigint FROM prepared_actions
WHERE user_id = @user_id AND status = 'prepared' AND expires_at > @now;

-- name: DiscardAction :execrows
UPDATE prepared_actions SET status = 'discarded', updated_at = now()
WHERE id = @id AND user_id = @user_id AND status = 'prepared';

-- name: SpendingByCategory :many
-- Naira that left each category in a period, for the spending chart.
SELECT category, sum(amount_minor)::bigint AS total_minor
FROM transactions
WHERE user_id = @user_id AND status = 'completed' AND direction = 'debit' AND currency = 'NGN'
  AND type IN ('transfer_out', 'card_payment', 'bill_payment', 'fee', 'levy')
  AND created_at >= @from_time AND created_at < @to_time
GROUP BY category
ORDER BY total_minor DESC;
