-- name: LockAccounts :many
-- Row-locks the accounts in ID order. Every writer locks in the same order, so two
-- entries touching the same accounts queue instead of deadlocking (the Sort runs below
-- the lock, so rows are locked as they come out sorted).
SELECT * FROM ledger_accounts WHERE id = ANY(@ids::uuid[]) ORDER BY id FOR UPDATE;

-- name: GetAccount :one
SELECT * FROM ledger_accounts WHERE id = $1;

-- name: SetAccountBalances :execrows
-- Writes the cached balances. The version check is a second guard behind the row lock:
-- a writer that read a stale row updates nothing and the engine refuses the entry.
UPDATE ledger_accounts
SET balance_minor = @balance_minor, available_minor = @available_minor, version = version + 1
WHERE id = @id AND version = @version;

-- name: InsertEntry :one
-- ON CONFLICT keeps the transaction usable when the operation already posted: no row
-- comes back and the engine reports ErrDuplicateEntry.
INSERT INTO journal_entries (id, kind, reference, idempotency_key, approval_id, metadata)
VALUES (@id, @kind, @reference, sqlc.narg('idempotency_key'), sqlc.narg('approval_id'), @metadata)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING *;

-- name: GetEntryByIdempotencyKey :one
SELECT * FROM journal_entries WHERE idempotency_key = $1;

-- name: InsertPosting :one
INSERT INTO postings (id, entry_id, account_id, amount_minor, currency, balance_after_minor)
VALUES (@id, @entry_id, @account_id, @amount_minor, @currency, @balance_after_minor)
RETURNING *;

-- name: ListEntryPostings :many
SELECT * FROM postings WHERE entry_id = $1 ORDER BY id;

-- name: InsertHold :one
INSERT INTO account_holds (id, account_id, currency, amount_minor, reference)
VALUES (@id, @account_id, @currency, @amount_minor, @reference)
RETURNING *;

-- name: GetHold :one
SELECT * FROM account_holds WHERE id = $1;

-- name: LockHolds :many
-- Holds are locked after their accounts, in ID order, by every writer.
SELECT * FROM account_holds WHERE id = ANY(@ids::uuid[]) ORDER BY id FOR UPDATE;

-- name: CloseHold :exec
UPDATE account_holds
SET status = @status, entry_id = sqlc.narg('entry_id'), closed_at = now()
WHERE id = @id AND status = 'active';

-- name: ListDrift :many
-- Accounts whose cached balances disagree with the postings and active holds. Always
-- empty while every write goes through the engine; the invariant tests and the
-- reconciliation job read it.
SELECT a.id, a.balance_minor, a.available_minor,
       COALESCE(p.total, 0)::bigint AS posted_minor,
       COALESCE(h.total, 0)::bigint AS held_minor
FROM ledger_accounts a
LEFT JOIN (SELECT account_id, sum(amount_minor) AS total FROM postings GROUP BY account_id) p ON p.account_id = a.id
LEFT JOIN (SELECT account_id, sum(amount_minor) AS total FROM account_holds WHERE status = 'active' GROUP BY account_id) h
  ON h.account_id = a.id
WHERE a.balance_minor <> COALESCE(p.total, 0)
   OR a.available_minor <> COALESCE(p.total, 0) - COALESCE(h.total, 0)
ORDER BY a.id;
