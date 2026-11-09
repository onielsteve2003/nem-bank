-- name: InsertTransfer :one
INSERT INTO transfers (
  id, user_id, reference, rail, source_account_id, destination_account_id, recipient, currency, amount_minor,
  fee_minor, narration, category, transaction_id, duress_blocked, hold_id, bank_code, account_number, partner,
  saga_deadline, limit_day
) VALUES (
  @id, @user_id, @reference, @rail, @source_account_id, sqlc.narg('destination_account_id'), @recipient, @currency,
  @amount_minor, @fee_minor, @narration, sqlc.narg('category'), @transaction_id, @duress_blocked, sqlc.narg('hold_id'),
  sqlc.narg('bank_code'), sqlc.narg('account_number'), sqlc.narg('partner'), sqlc.narg('saga_deadline'), @limit_day
)
RETURNING *;

-- name: SetTransferStatus :one
-- Moves a transfer on from the state the caller saw. The transition trigger refuses an
-- illegal move; the status guard turns a lost race into no row instead of a double move.
UPDATE transfers
SET status = @to_status, entry_id = coalesce(sqlc.narg('entry_id'), entry_id), updated_at = clock_timestamp()
WHERE id = @id AND status = @from_status
RETURNING *;

-- name: InsertTransferEvent :exec
INSERT INTO transfer_events (transfer_id, seq, status, label, detail)
VALUES (@transfer_id, (SELECT coalesce(max(seq), 0) + 1 FROM transfer_events WHERE transfer_id = @transfer_id),
        @status, @label, sqlc.narg('detail'));

-- name: GetTransfer :one
SELECT * FROM transfers WHERE id = @id AND user_id = @user_id;

-- name: GetTransferByID :one
SELECT * FROM transfers WHERE id = $1;

-- name: ListTransfers :many
SELECT * FROM transfers
WHERE user_id = @user_id
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status'))
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (created_at, id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY created_at DESC, id DESC
LIMIT @lim;

-- name: ListTransferEvents :many
-- The timelines of a page of transfers in one query.
SELECT * FROM transfer_events WHERE transfer_id = ANY(@ids::uuid[]) ORDER BY transfer_id, seq;

-- name: LockDuressTransfers :many
-- Transfers accepted under duress that are still "on their way".
SELECT * FROM transfers
WHERE user_id = $1 AND duress_blocked AND status = 'processing'
ORDER BY id
FOR UPDATE;

-- name: LockTransfer :one
-- The saga's steps (send, status check, callback) take this lock, so two answers for the
-- same transfer are judged one after the other, never both on the same old status.
SELECT * FROM transfers WHERE id = $1 FOR UPDATE;

-- name: GetTransferByReference :one
SELECT * FROM transfers WHERE reference = $1;

-- name: SetPartnerReference :exec
UPDATE transfers SET partner_reference = @partner_reference, updated_at = clock_timestamp()
WHERE id = @id AND partner_reference IS NULL;

-- name: SetTransferReversal :exec
UPDATE transfers SET reversal = @reversal, updated_at = clock_timestamp() WHERE id = @id AND reversal IS NULL;

-- name: InsertPartnerWebhookEvent :one
-- No row back means the event was handled before.
INSERT INTO partner_webhook_events (partner, event_id, event_type, reference, outcome)
VALUES (@partner, @event_id, @event_type, @reference, @outcome)
ON CONFLICT (partner, event_id) DO NOTHING
RETURNING partner;
