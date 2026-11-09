-- name: NextNubanSerial :one
SELECT nextval('nuban_serial')::bigint;

-- name: NextWalletSerial :one
SELECT nextval('wallet_number_serial')::bigint;

-- name: InsertCustomerAccount :one
INSERT INTO customer_accounts (account_id, user_id, currency, kind, account_number)
VALUES (@account_id, @user_id, @currency, @kind, @account_number)
RETURNING *;

-- name: InsertLedgerAccount :exec
-- The customer's ledger account, opened with the details row in one transaction. Balances
-- start at zero and only ever move through the posting engine.
INSERT INTO ledger_accounts (id, owner_type, owner_id, kind, currency, name)
VALUES (@id, 'customer', @owner_id, @kind, @currency, @name);

-- name: ListCustomerAccounts :many
-- NGN first, then the wallets in the app's order.
SELECT c.*, l.balance_minor, l.available_minor
FROM customer_accounts c
JOIN ledger_accounts l ON l.id = c.account_id
WHERE c.user_id = $1
ORDER BY array_position(ARRAY['NGN', 'USD', 'GBP', 'EUR'], c.currency);

-- name: GetCustomerAccount :one
SELECT c.*, l.balance_minor, l.available_minor
FROM customer_accounts c
JOIN ledger_accounts l ON l.id = c.account_id
WHERE c.account_id = @account_id AND c.user_id = @user_id;

-- name: GetCustomerAccountByCurrency :one
SELECT * FROM customer_accounts WHERE user_id = @user_id AND currency = @currency;

-- name: InsertTransaction :one
INSERT INTO transactions (
  id, user_id, account_id, currency, entry_id, type, direction, status, amount_minor, fee_minor, fee_code,
  balance_after_minor, narration, reference, category, category_source, counterparty, transfer_id, card_id, created_at
) VALUES (
  @id, @user_id, @account_id, @currency, sqlc.narg('entry_id'), @type, @direction, @status, @amount_minor,
  sqlc.narg('fee_minor'), sqlc.narg('fee_code'), sqlc.narg('balance_after_minor'), @narration, @reference, @category,
  @category_source, @counterparty, sqlc.narg('transfer_id'), sqlc.narg('card_id'), @created_at
)
RETURNING *;

-- name: SettleTransaction :one
-- A pending line whose money has now moved (or failed to): the entry and balance arrive
-- with the status.
UPDATE transactions
SET status = @status, entry_id = coalesce(sqlc.narg('entry_id'), entry_id),
    balance_after_minor = coalesce(sqlc.narg('balance_after_minor'), balance_after_minor), updated_at = now()
WHERE id = @id
RETURNING *;

-- name: GetTransaction :one
SELECT * FROM transactions WHERE id = @id AND user_id = @user_id;

-- name: ListTransactions :many
-- The customer's history, newest first, keyset paged on (created_at, id). Every filter is
-- optional; the date range is a half-open [from, until) pair of instants worked out in
-- Lagos time by the caller, so the index still serves the range.
SELECT * FROM transactions t
WHERE t.user_id = @user_id
  AND (sqlc.narg('account_id')::uuid IS NULL OR t.account_id = sqlc.narg('account_id'))
  AND (sqlc.narg('types')::text[] IS NULL OR t.type = ANY(sqlc.narg('types')::text[]))
  AND (sqlc.narg('currency')::text IS NULL OR t.currency = sqlc.narg('currency'))
  AND (sqlc.narg('status')::text IS NULL OR t.status = sqlc.narg('status'))
  AND (sqlc.narg('category')::text IS NULL OR t.category = sqlc.narg('category'))
  AND (sqlc.narg('since')::timestamptz IS NULL OR t.created_at >= sqlc.narg('since'))
  AND (sqlc.narg('until')::timestamptz IS NULL OR t.created_at < sqlc.narg('until'))
  AND (sqlc.narg('max_amount_minor')::bigint IS NULL OR t.amount_minor <= sqlc.narg('max_amount_minor'))
  AND (sqlc.narg('pattern')::text IS NULL
       OR t.narration ILIKE sqlc.narg('pattern')
       OR t.counterparty ->> 'name' ILIKE sqlc.narg('pattern')
       OR t.reference ILIKE sqlc.narg('pattern'))
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (t.created_at, t.id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY t.created_at DESC, t.id DESC
LIMIT @lim;

-- name: ListLinesForEntries :many
-- The customer-facing lines behind an account's entries, for statement narrations.
SELECT entry_id, type, narration, reference FROM transactions
WHERE account_id = @account_id AND entry_id = ANY(@entry_ids::uuid[]);

-- name: GetCurrentAccountByNumber :one
-- A Nem current account by its NUBAN: where internal transfers land.
SELECT * FROM customer_accounts WHERE account_number = $1 AND kind = 'ngn_current';

-- name: GetCustomerAccountByID :one
-- Where a held internal transfer lands when it is released.
SELECT * FROM customer_accounts WHERE account_id = $1;
