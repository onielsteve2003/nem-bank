-- name: InsertTransfer :one
INSERT INTO transfers (
  id, user_id, reference, rail, source_account_id, destination_account_id, recipient, currency, amount_minor,
  fee_minor, narration, category, transaction_id, duress_blocked
) VALUES (
  @id, @user_id, @reference, @rail, @source_account_id, sqlc.narg('destination_account_id'), @recipient, @currency,
  @amount_minor, @fee_minor, @narration, sqlc.narg('category'), @transaction_id, @duress_blocked
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
