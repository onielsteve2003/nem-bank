-- name: GetSystemAccount :one
-- The bank's account of a kind in a currency (seeded by migration 00009).
SELECT * FROM ledger_accounts
WHERE owner_type = 'system' AND kind = $1 AND currency = $2;

-- name: ListSystemAccounts :many
SELECT * FROM ledger_accounts WHERE owner_type = 'system' ORDER BY kind, currency;
