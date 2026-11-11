-- name: InsertAttachment :exec
INSERT INTO attachments (id, user_id, purpose, file_name, content_type, size_bytes, caption, data, created_at)
VALUES (@id, @user_id, @purpose, @file_name, @content_type, @size_bytes, @caption, @data, @created_at);

-- name: GetAttachmentMeta :one
SELECT id, user_id, purpose, file_name, content_type, size_bytes, caption, created_at FROM attachments WHERE id = @id;

-- name: GetAttachmentData :one
SELECT content_type, file_name, data FROM attachments WHERE id = @id;

-- name: ListAttachmentMeta :many
SELECT id, user_id, purpose, file_name, content_type, size_bytes, caption, created_at
FROM attachments WHERE id = ANY(@ids::uuid[]);

-- name: CountAttachmentsSince :one
SELECT count(*) FROM attachments WHERE user_id = @user_id AND created_at >= @since;

-- name: AttachmentsInUse :one
-- How many of these files a dispute or a chat message already uses.
SELECT ((SELECT count(*) FROM disputes WHERE evidence_ids && @ids::uuid[]) + (SELECT count(*) FROM support_messages WHERE attachment_ids && @ids::uuid[]))::bigint;

-- name: NextCaseNumber :one
SELECT ('DSP-' || nextval('dispute_case_seq')::text)::text AS case_number;

-- name: InsertDispute :one
INSERT INTO disputes (id, user_id, transaction_id, case_number, reason, description, status, evidence_ids, created_at)
VALUES (@id, @user_id, @transaction_id, @case_number, @reason, @description, 'submitted', @evidence_ids, @created_at)
RETURNING *;

-- name: InsertDisputeEvent :exec
INSERT INTO dispute_events (id, dispute_id, status, label, detail, at)
VALUES (@id, @dispute_id, @status, @label, @detail, @at);

-- name: ListDisputeEvents :many
SELECT * FROM dispute_events WHERE dispute_id = @dispute_id ORDER BY at, id;

-- name: GetDispute :one
SELECT * FROM disputes WHERE id = @id AND user_id = @user_id;

-- name: GetDisputeAny :one
SELECT * FROM disputes WHERE id = @id;

-- name: LockDispute :one
SELECT * FROM disputes WHERE id = @id FOR UPDATE;

-- name: ListDisputes :many
SELECT * FROM disputes
WHERE user_id = @user_id AND (created_at, id) < (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at DESC, id DESC
LIMIT @page_size;

-- name: ListDisputeQueue :many
-- Staff queue, oldest first. An empty status means every open one.
SELECT * FROM disputes
WHERE (@status::text = '' AND status IN ('submitted', 'under_review', 'awaiting_customer') OR status = @status::text)
  AND (created_at, id) > (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at, id
LIMIT @page_size;

-- name: SetDisputeStatus :one
UPDATE disputes SET status = @status, resolution_note = COALESCE(@resolution_note, resolution_note),
  resolved_at = @resolved_at, reviewer_id = COALESCE(@reviewer_id, reviewer_id)
WHERE id = @id
RETURNING *;

-- name: SetDisputeRefund :one
UPDATE disputes SET status = 'resolved_refunded', resolution_note = @resolution_note, resolved_at = @resolved_at,
  reviewer_id = @reviewer_id, refund_minor = @refund_minor, refund_currency = @refund_currency,
  refund_transaction_id = @refund_transaction_id
WHERE id = @id
RETURNING *;

-- name: AddDisputeEvidence :one
UPDATE disputes SET evidence_ids = array_append(evidence_ids, @attachment_id::uuid) WHERE id = @id RETURNING *;

-- name: GetTransactionAny :one
SELECT * FROM transactions WHERE id = @id;

-- name: InsertConversation :one
INSERT INTO support_conversations (id, user_id, subject, status, agent_id, agent_name, transaction_id, last_message_at, created_at)
VALUES (@id, @user_id, @subject, 'open', @agent_id, @agent_name, @transaction_id, @at, @at)
RETURNING *;

-- name: GetConversation :one
SELECT * FROM support_conversations WHERE id = @id AND user_id = @user_id;

-- name: GetConversationAny :one
SELECT * FROM support_conversations WHERE id = @id;

-- name: LockConversation :one
SELECT * FROM support_conversations WHERE id = @id FOR UPDATE;

-- name: ListConversations :many
-- Open chats first, then the most recently active.
SELECT * FROM support_conversations WHERE user_id = @user_id
ORDER BY (status = 'resolved'), last_message_at DESC, id DESC
LIMIT 50;

-- name: ListAgentConversations :many
SELECT * FROM support_conversations
WHERE (@status::text = '' OR status = @status::text)
  AND (@agent_id::uuid = '00000000-0000-0000-0000-000000000000'::uuid OR agent_id = @agent_id::uuid)
  AND (last_message_at, id) > (@after_time::timestamptz, @after_id::uuid)
ORDER BY last_message_at, id
LIMIT @page_size;

-- name: SetConversationAgent :one
UPDATE support_conversations SET agent_id = @agent_id, agent_name = @agent_name WHERE id = @id RETURNING *;

-- name: SetConversationStatus :one
UPDATE support_conversations SET status = @status WHERE id = @id RETURNING *;

-- name: TouchConversation :one
UPDATE support_conversations SET last_message_at = @at, status = @status WHERE id = @id RETURNING *;

-- name: PickAgent :one
-- The enabled support agent with the fewest unresolved chats; ties go to the lowest ID, so the
-- choice is the same on every call and tests are deterministic.
SELECT s.id, s.name FROM staff s
WHERE s.disabled_at IS NULL AND 'support' = ANY(s.roles)
ORDER BY (SELECT count(*) FROM support_conversations c WHERE c.agent_id = s.id AND c.status <> 'resolved'), s.id
LIMIT 1;

-- name: InsertMessage :one
INSERT INTO support_messages (id, conversation_id, sender, sender_name, body, attachment_ids, created_at)
VALUES (@id, @conversation_id, @sender, @sender_name, @body, @attachment_ids, @created_at)
RETURNING *;

-- name: GetMessage :one
SELECT * FROM support_messages WHERE id = @id;

-- name: ListMessages :many
SELECT * FROM support_messages
WHERE conversation_id = @conversation_id AND (created_at, id) < (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at DESC, id DESC
LIMIT @page_size;

-- name: MarkMessagesRead :exec
-- The reader marks the other side's messages. 'agent' messages are read by the customer and
-- vice versa; system messages count as the agent's.
UPDATE support_messages SET read_at = @now
WHERE conversation_id = @conversation_id AND read_at IS NULL AND sender = ANY(@senders::text[]);

-- name: CountUnreadFor :one
SELECT count(*) FROM support_messages
WHERE conversation_id = @conversation_id AND read_at IS NULL AND sender = ANY(@senders::text[]);

-- name: CountStartedSince :one
SELECT count(*) FROM support_conversations WHERE user_id = @user_id AND created_at >= @since;

-- name: CustomerBrief :one
SELECT id, first_name, last_name FROM users WHERE id = @user_id;
