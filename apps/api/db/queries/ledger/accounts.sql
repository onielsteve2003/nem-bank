-- name: GetSystemAccount :one
-- The bank's account of a kind in a currency (seeded by migration 00009).
SELECT * FROM ledger_accounts
WHERE owner_type = 'system' AND kind = $1 AND currency = $2;

-- name: ListSystemAccounts :many
SELECT * FROM ledger_accounts WHERE owner_type = 'system' ORDER BY kind, currency;

-- name: InsertCustomerLedgerAccount :exec
-- A customer extra ledger account (a savings goal, a lock): balances start at zero and
-- only ever move through the posting engine.
INSERT INTO ledger_accounts (id, owner_type, owner_id, kind, currency, name)
VALUES (@id, 'customer', @owner_id, @kind, @currency, @name);

-- name: InsertSystemLedgerAccount :exec
-- A bank system account (such as an ajo escrow pot): owner_id is NULL.
INSERT INTO ledger_accounts (id, owner_type, owner_id, kind, currency, name)
VALUES (@id, 'system', NULL, @kind, @currency, @name);
