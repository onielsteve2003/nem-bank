-- name: InsertMoneyRequest :one
INSERT INTO money_requests (id, requester_id, payer_id, currency, amount_minor, note, split_bill_id, created_at, expires_at)
VALUES (@id, @requester_id, @payer_id, @currency, @amount_minor, @note, sqlc.narg('split_bill_id'), @created_at, @expires_at)
RETURNING *;

-- name: ExpireMoneyRequests :exec
-- Pending requests past their expiry, for one customer, before they are read.
UPDATE money_requests SET status = 'expired', responded_at = expires_at
WHERE status = 'pending' AND expires_at <= @now AND (requester_id = @user_id OR payer_id = @user_id);

-- name: GetMoneyRequest :one
-- Either side may read it.
SELECT * FROM money_requests WHERE id = @id AND (requester_id = @user_id OR payer_id = @user_id);

-- name: LockMoneyRequest :one
SELECT * FROM money_requests WHERE id = @id AND (requester_id = @user_id OR payer_id = @user_id) FOR UPDATE;

-- name: ListMoneyRequests :many
SELECT * FROM money_requests
WHERE CASE WHEN @incoming::boolean THEN payer_id = @user_id ELSE requester_id = @user_id END
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status'))
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (created_at, id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY created_at DESC, id DESC
LIMIT @lim;

-- name: RespondMoneyRequest :one
UPDATE money_requests
SET status = @status, transfer_id = sqlc.narg('transfer_id'), responded_at = @responded_at
WHERE id = @id AND status = 'pending'
RETURNING *;

-- name: ListSplitRequests :many
SELECT * FROM money_requests WHERE split_bill_id = ANY(@split_ids::uuid[]) ORDER BY split_bill_id, created_at, id;

-- name: RemindSplitRequests :many
-- Pending shares not reminded in the last day get reminded now.
UPDATE money_requests SET last_reminded_at = @now
WHERE split_bill_id = @split_bill_id AND status = 'pending'
  AND (last_reminded_at IS NULL OR last_reminded_at <= @due_before)
RETURNING *;

-- name: InsertSplitBill :one
INSERT INTO split_bills (id, user_id, title, currency, total_minor, split, self_minor, created_at)
VALUES (@id, @user_id, @title, @currency, @total_minor, @split, sqlc.narg('self_minor'), @created_at)
RETURNING *;

-- name: GetSplitBill :one
SELECT * FROM split_bills WHERE id = @id AND user_id = @user_id;

-- name: ListSplitBills :many
SELECT * FROM split_bills
WHERE user_id = @user_id
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (created_at, id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY created_at DESC, id DESC
LIMIT @lim;

-- name: InsertPaymentLink :one
INSERT INTO payment_links (id, user_id, account_id, slug, title, note, amount_mode, currency, amount_minor, expires_at, created_at)
VALUES (@id, @user_id, @account_id, @slug, @title, sqlc.narg('note'), @amount_mode, @currency, sqlc.narg('amount_minor'),
        sqlc.narg('expires_at'), @created_at)
RETURNING *;

-- name: GetPaymentLink :one
SELECT * FROM payment_links WHERE id = @id AND user_id = @user_id;

-- name: GetPaymentLinkBySlug :one
SELECT * FROM payment_links WHERE slug = $1;

-- name: LockPaymentLinkBySlug :one
SELECT * FROM payment_links WHERE slug = $1 FOR UPDATE;

-- name: ListPaymentLinks :many
SELECT * FROM payment_links
WHERE user_id = @user_id
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (created_at, id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY created_at DESC, id DESC
LIMIT @lim;

-- name: UpdatePaymentLink :one
UPDATE payment_links
SET title = coalesce(sqlc.narg('title'), title),
    note = CASE WHEN @set_note::boolean THEN sqlc.narg('note') ELSE note END,
    status = coalesce(sqlc.narg('status'), status)
WHERE id = @id AND user_id = @user_id
RETURNING *;

-- name: CountLinkPayment :exec
UPDATE payment_links
SET payments_count = payments_count + 1, total_received_minor = total_received_minor + @amount_minor
WHERE id = @id;
