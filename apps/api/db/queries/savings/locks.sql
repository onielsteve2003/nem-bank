-- name: InsertLock :one
INSERT INTO locked_savings (
  id, user_id, account_id, principal_minor, term_days, rate_bps, early_break_penalty_bps,
  start_date, maturity_date, expected_interest_minor, created_at
) VALUES (
  @id, @user_id, @account_id, @principal_minor, @term_days, @rate_bps, @early_break_penalty_bps,
  @start_date, @maturity_date, @expected_interest_minor, @created_at
)
RETURNING *;

-- name: GetLock :one
SELECT * FROM locked_savings WHERE id = @id AND user_id = @user_id;

-- name: LockLock :one
-- Held while interest is posted or the lock is paid out, so a lock ends exactly once.
SELECT * FROM locked_savings WHERE id = @id FOR UPDATE;

-- name: ListLocks :many
-- Active locks first, then the most recently started.
SELECT * FROM locked_savings
WHERE user_id = @user_id
ORDER BY (status = 'active') DESC, start_date DESC, id DESC;

-- name: CountActiveLocks :one
SELECT count(*) FROM locked_savings WHERE user_id = @user_id AND status = 'active';

-- name: ListLocksToAdvance :many
-- Active locks that have a day of interest to post or have reached maturity.
SELECT id FROM locked_savings
WHERE status = 'active' AND (accrued_days < LEAST(term_days, sqlc.arg(today)::date - start_date) OR maturity_date <= sqlc.arg(today)::date)
ORDER BY maturity_date
LIMIT 200;

-- name: SetLockAccrual :exec
UPDATE locked_savings SET accrued_interest_minor = @accrued_interest_minor, accrued_days = @accrued_days WHERE id = @id;

-- name: EndLock :one
UPDATE locked_savings
SET status = @status, paid_out_minor = @paid_out_minor, ended_at = @at
WHERE id = @id AND status = 'active'
RETURNING *;

-- name: LockTotals :one
-- What the Grow tab adds up for locks: principal still locked, interest earned (accrued on
-- running locks, kept on finished ones) and how many are running.
SELECT coalesce(sum(principal_minor + accrued_interest_minor) FILTER (WHERE status = 'active'), 0)::bigint AS locked,
       coalesce(sum(CASE WHEN status = 'active' THEN accrued_interest_minor ELSE paid_out_minor - principal_minor END), 0)::bigint AS interest,
       (count(*) FILTER (WHERE status = 'active'))::int AS running
FROM locked_savings WHERE user_id = @user_id;

-- name: ListGoalsToPay :many
-- Open goals owed interest: the last day paid is before today (Lagos).
SELECT id FROM savings_goals WHERE status = 'active' AND interest_paid_to < sqlc.arg(today)::date ORDER BY interest_paid_to LIMIT 200;

-- name: SetGoalInterest :exec
UPDATE savings_goals
SET interest_earned_minor = interest_earned_minor + @paid_minor, interest_paid_to = @paid_to
WHERE id = @id;

-- name: GetLockOwner :one
-- Without the caller, for the sweep that pays locks out.
SELECT user_id FROM locked_savings WHERE id = @id;
