-- name: InsertBillPayment :one
INSERT INTO bill_payments (
  id, user_id, account_id, reference, biller_id, biller_name, category, product_id, product_name,
  customer_id, amount_minor, fee_minor, limit_day, entry_id, transaction_id, created_at
) VALUES (
  @id, @user_id, @account_id, @reference, @biller_id, @biller_name, @category, sqlc.narg('product_id'), sqlc.narg('product_name'),
  @customer_id, @amount_minor, @fee_minor, @limit_day, @entry_id, @transaction_id, @created_at
)
RETURNING *;

-- name: LockBillPayment :one
-- Held while the outcome is recorded, so a payment finishes exactly once.
SELECT * FROM bill_payments WHERE id = @id FOR UPDATE;

-- name: GetBillPayment :one
SELECT * FROM bill_payments WHERE id = @id AND user_id = @user_id;

-- name: CompleteBillPayment :one
UPDATE bill_payments
SET status = 'completed', token = sqlc.narg('token'), units = sqlc.narg('units'), completed_at = @at
WHERE id = @id AND status = 'processing'
RETURNING *;

-- name: ReverseBillPayment :one
UPDATE bill_payments
SET status = 'reversed', reversal_entry_id = @reversal_entry_id, failure_reason = @failure_reason, completed_at = @at
WHERE id = @id AND status = 'processing'
RETURNING *;

-- name: ListBillPayments :many
-- The customer's payments, newest first, keyset paged on (created_at, id).
SELECT * FROM bill_payments
WHERE user_id = @user_id
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (created_at, id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY created_at DESC, id DESC
LIMIT @row_limit;

-- name: ListStuckBillPayments :many
-- Debited but not finished: the process died between taking the money and asking the biller.
SELECT id FROM bill_payments WHERE status = 'processing' AND created_at < @before ORDER BY created_at LIMIT 100;

-- name: GetBillPaymentByID :one
-- Without the owner, for the sweep that finishes stuck payments.
SELECT * FROM bill_payments WHERE id = @id;
