-- name: InsertStatement :one
INSERT INTO statements (id, user_id, account_id, currency, period_from, period_to)
VALUES (@id, @user_id, @account_id, @currency, @period_from, @period_to)
RETURNING id, user_id, account_id, currency, period_from, period_to, status, opening_balance_minor,
          closing_balance_minor, sha256, verification_code, created_at, ready_at;

-- name: GetStatement :one
SELECT id, user_id, account_id, currency, period_from, period_to, status, opening_balance_minor,
       closing_balance_minor, sha256, verification_code, created_at, ready_at
FROM statements WHERE id = @id AND user_id = @user_id;

-- name: ListStatements :many
-- Newest first, keyset paged. The PDF column is left out: lists never need it.
SELECT id, user_id, account_id, currency, period_from, period_to, status, opening_balance_minor,
       closing_balance_minor, sha256, verification_code, created_at, ready_at
FROM statements
WHERE user_id = @user_id
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (created_at, id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY created_at DESC, id DESC
LIMIT @lim;

-- name: LockStatement :one
-- The generator works one statement at a time, under its row lock.
SELECT id, user_id, account_id, currency, period_from, period_to, status, created_at
FROM statements WHERE id = $1 FOR UPDATE;

-- name: CompleteStatement :exec
UPDATE statements
SET status = 'ready', opening_balance_minor = @opening_balance_minor, closing_balance_minor = @closing_balance_minor,
    sha256 = @sha256, verification_code = @verification_code, pdf = @pdf, ready_at = now()
WHERE id = @id AND status = 'generating';

-- name: FailStatement :exec
UPDATE statements SET status = 'failed' WHERE id = $1 AND status = 'generating';

-- name: GetStatementPDF :one
SELECT status, pdf FROM statements WHERE id = @id AND user_id = @user_id;

-- name: GetStatementByCode :one
-- The public verification page: just enough to confirm the document, nothing to act on.
SELECT s.currency, s.period_from, s.period_to, s.sha256, s.ready_at, c.account_number, s.user_id
FROM statements s
JOIN customer_accounts c ON c.account_id = s.account_id
WHERE s.verification_code = $1 AND s.status = 'ready';

-- name: AccountsWithoutSnapshot :many
-- Customer accounts open before the day ended that have no balance for that day yet.
SELECT c.account_id FROM customer_accounts c
WHERE c.opened_at < @day_end
  AND NOT EXISTS (SELECT 1 FROM daily_balances d WHERE d.account_id = c.account_id AND d.as_of = @as_of)
ORDER BY c.account_id;

-- name: InsertDailyBalances :exec
-- Written once: a re-run (or a second instance) leaves the first row in place.
INSERT INTO daily_balances (account_id, as_of, balance_minor)
SELECT unnest(@account_ids::uuid[]), @as_of::date, unnest(@balances::bigint[])
ON CONFLICT (account_id, as_of) DO NOTHING;
