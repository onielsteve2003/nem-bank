-- name: InsertTransfer :one
INSERT INTO transfers (
  id, user_id, reference, rail, source_account_id, destination_account_id, recipient, currency, amount_minor,
  fee_minor, narration, category, transaction_id, duress_blocked, hold_id, bank_code, account_number, partner,
  saga_deadline, limit_day, beneficiary_id, release_at, money_request_id, payment_link_id
) VALUES (
  @id, @user_id, @reference, @rail, @source_account_id, sqlc.narg('destination_account_id'), @recipient, @currency,
  @amount_minor, @fee_minor, @narration, sqlc.narg('category'), @transaction_id, @duress_blocked, sqlc.narg('hold_id'),
  sqlc.narg('bank_code'), sqlc.narg('account_number'), sqlc.narg('partner'), sqlc.narg('saga_deadline'), @limit_day,
  sqlc.narg('beneficiary_id'), sqlc.narg('release_at'), sqlc.narg('money_request_id'), sqlc.narg('payment_link_id')
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

-- name: SetSagaDeadline :exec
-- A transfer that waited (cooling-off, step-up) gets the partner's full time from when it goes.
UPDATE transfers SET saga_deadline = @saga_deadline, updated_at = clock_timestamp() WHERE id = @id;

-- name: SetTransferBeneficiary :exec
UPDATE transfers SET beneficiary_id = @beneficiary_id WHERE id = @id;

-- name: InsertBeneficiary :one
-- Saving one twice returns no row: the caller says it is already saved.
INSERT INTO beneficiaries (id, user_id, kind, name, nickname, nemtag, bank_code, bank_name, account_number, favourite, cooling_off_until)
VALUES (@id, @user_id, @kind, @name, sqlc.narg('nickname'), sqlc.narg('nemtag'), @bank_code, @bank_name, @account_number, @favourite,
        @cooling_off_until)
ON CONFLICT (user_id, bank_code, account_number) DO NOTHING
RETURNING *;

-- name: GetBeneficiary :one
SELECT * FROM beneficiaries WHERE id = @id AND user_id = @user_id;

-- name: FindBeneficiary :one
SELECT * FROM beneficiaries WHERE user_id = @user_id AND bank_code = @bank_code AND account_number = @account_number;

-- name: ListBeneficiaries :many
-- Favourites first, then most recently paid, then by name (the mock's order). A customer
-- has tens of these, so pages are by offset.
SELECT * FROM beneficiaries
WHERE user_id = @user_id
  AND (sqlc.narg('favourite')::boolean IS NULL OR favourite = sqlc.narg('favourite'))
  AND (sqlc.narg('q')::text IS NULL OR concat_ws(' ', name, nickname, nemtag, account_number, bank_name) ILIKE
       '%' || replace(replace(replace(sqlc.narg('q'), '\', '\\'), '%', '\%'), '_', '\_') || '%')
ORDER BY favourite DESC, last_paid_at DESC NULLS LAST, name, id
LIMIT @lim OFFSET @off;

-- name: UpdateBeneficiary :one
UPDATE beneficiaries
SET nickname = CASE WHEN @set_nickname::boolean THEN sqlc.narg('nickname') ELSE nickname END,
    favourite = coalesce(sqlc.narg('favourite'), favourite)
WHERE id = @id AND user_id = @user_id
RETURNING *;

-- name: DeleteBeneficiary :execrows
DELETE FROM beneficiaries WHERE id = @id AND user_id = @user_id;

-- name: MarkBeneficiaryPaid :exec
-- Paid once, the beneficiary is no longer new.
UPDATE beneficiaries SET last_paid_at = @at WHERE id = @id;

-- name: InsertSchedule :one
INSERT INTO scheduled_transfers (id, user_id, source_account_id, destination, recipient, currency, amount_minor, narration,
                                 frequency, next_run_at, ends_on)
VALUES (@id, @user_id, @source_account_id, @destination, @recipient, @currency, @amount_minor, @narration, @frequency,
        @next_run_at, sqlc.narg('ends_on'))
RETURNING *;

-- name: GetSchedule :one
SELECT * FROM scheduled_transfers WHERE id = @id AND user_id = @user_id;

-- name: LockSchedule :one
SELECT * FROM scheduled_transfers WHERE id = @id AND user_id = @user_id FOR UPDATE;

-- name: ListSchedules :many
-- Next run first; ended schedules last, newest first.
SELECT * FROM scheduled_transfers
WHERE user_id = @user_id
ORDER BY next_run_at NULLS LAST, created_at DESC, id
LIMIT @lim OFFSET @off;

-- name: SaveSchedule :one
UPDATE scheduled_transfers
SET status = @status, amount_minor = @amount_minor, next_run_at = sqlc.narg('next_run_at'), run_count = @run_count,
    last_run = sqlc.narg('last_run'), updated_at = now()
WHERE id = @id
RETURNING *;

-- name: ListDueSchedules :many
SELECT id, user_id FROM scheduled_transfers
WHERE status = 'active' AND next_run_at <= @now
ORDER BY next_run_at
LIMIT @lim;

-- name: ClaimDueSchedule :one
-- One runner at a time per schedule; a schedule another runner holds is skipped, not waited on.
SELECT * FROM scheduled_transfers
WHERE id = @id AND status = 'active' AND next_run_at <= @now
FOR UPDATE SKIP LOCKED;

-- name: ListCompletedInterbank :many
-- Interbank transfers the ledger paid out in [from_at, to_at): the time is the timeline's
-- 'completed' step.
SELECT t.reference, t.amount_minor, t.currency
FROM transfers t
JOIN transfer_events e ON e.transfer_id = t.id AND e.status = 'completed'
WHERE t.rail = 'interbank' AND t.partner = @partner AND t.status = 'completed'
  AND e.at >= @from_at AND e.at < @to_at
ORDER BY e.at, t.reference;

-- name: SetTransferRisk :exec
-- The assessment the customer and staff see on the transfer (contract RiskAssessment).
UPDATE transfers SET risk = @risk, updated_at = clock_timestamp() WHERE id = @id;
