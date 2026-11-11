-- name: InsertOffer :one
INSERT INTO loan_offers (id, user_id, principal_minor, tenor_days, apr_bps, interest_minor, fee_minor, start_date, expires_at, created_at)
VALUES (@id, @user_id, @principal_minor, @tenor_days, @apr_bps, @interest_minor, @fee_minor, @start_date, @expires_at, @created_at)
RETURNING *;

-- name: LockOffer :one
-- Held while an offer is accepted, so a double tap cannot disburse twice.
SELECT * FROM loan_offers WHERE id = @id AND user_id = @user_id FOR UPDATE;

-- name: InsertLoan :one
INSERT INTO loans (
  id, user_id, offer_id, account_id, repayment_account_id, principal_minor, apr_bps, tenor_days,
  interest_minor, fee_minor, total_minor, start_date, auto_repay, disbursed_at
) VALUES (
  @id, @user_id, @offer_id, @account_id, @repayment_account_id, @principal_minor, @apr_bps, @tenor_days,
  @interest_minor, @fee_minor, @total_minor, @start_date, @auto_repay, @disbursed_at
)
RETURNING *;

-- name: InsertInstallment :exec
INSERT INTO loan_installments (loan_id, number, due_date, amount_minor) VALUES (@loan_id, @number, @due_date, @amount_minor);

-- name: GetLoanByOffer :one
SELECT * FROM loans WHERE offer_id = @offer_id AND user_id = @user_id;

-- name: GetLoan :one
SELECT sqlc.embed(l), a.balance_minor
FROM loans l JOIN ledger_accounts a ON a.id = l.account_id
WHERE l.id = @id AND l.user_id = @user_id;

-- name: LockLoan :one
-- Held while a repayment, an auto-repay or a status change runs, so they apply one at a time.
SELECT * FROM loans WHERE id = @id FOR UPDATE;

-- name: ListLoans :many
-- Open loans first, newest first within each.
SELECT sqlc.embed(l), a.balance_minor
FROM loans l JOIN ledger_accounts a ON a.id = l.account_id
WHERE l.user_id = @user_id
ORDER BY (l.status <> 'repaid') DESC, l.disbursed_at DESC, l.id DESC;

-- name: ListInstallments :many
SELECT * FROM loan_installments WHERE loan_id = @loan_id ORDER BY number;

-- name: ListInstallmentsForLoans :many
SELECT * FROM loan_installments WHERE loan_id = ANY(@loan_ids::uuid[]) ORDER BY loan_id, number;

-- name: SetInstallmentPaid :exec
UPDATE loan_installments SET paid_minor = @paid_minor WHERE loan_id = @loan_id AND number = @number;

-- name: MarkInstallmentOverdueNotified :exec
UPDATE loan_installments SET overdue_notified_at = @at WHERE loan_id = @loan_id AND number = @number;

-- name: SetLoanAutoRepay :exec
UPDATE loans SET auto_repay = @auto_repay WHERE id = @id;

-- name: SetLoanStatus :exec
UPDATE loans
SET status = @status, closed_at = sqlc.narg('closed_at'), rebate_minor = rebate_minor + @rebate_minor,
    defaulted_at = COALESCE(defaulted_at, sqlc.narg('defaulted_at'))
WHERE id = @id;

-- name: ListOpenLoanIDs :many
-- What the daily clock looks at: every loan still owing.
SELECT id FROM loans WHERE status <> 'repaid' ORDER BY disbursed_at;

-- name: UserCreatedAt :one
SELECT created_at FROM users WHERE id = @id;

-- name: SalarySince :one
-- What reached the customer's naira accounts as salary since a date (the scorer's main fact).
SELECT COALESCE(sum(amount_minor), 0)::bigint AS total_minor
FROM transactions
WHERE user_id = @user_id AND category = 'salary_income' AND direction = 'credit'
  AND status = 'completed' AND currency = 'NGN' AND created_at >= @since;

-- name: CountActiveGoals :one
SELECT count(*) FROM savings_goals WHERE user_id = @user_id AND status = 'active';

-- name: LoanHistory :one
-- Past behaviour for the scorer: loans repaid, and loans that ever went into default.
SELECT
  count(*) FILTER (WHERE status = 'repaid')::bigint   AS repaid,
  count(*) FILTER (WHERE defaulted_at IS NOT NULL)::bigint AS defaulted,
  count(*) FILTER (WHERE status <> 'repaid')::bigint   AS open
FROM loans WHERE user_id = @user_id;
