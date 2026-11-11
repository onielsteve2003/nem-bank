-- name: InsertQuote :one
INSERT INTO fx_quotes (
  id, user_id, from_account_id, to_account_id, sell_currency, sell_minor, buy_currency, buy_minor,
  rate_e8, mid_e8, spread_bps, fee_minor, created_at, expires_at
) VALUES (
  @id, @user_id, @from_account_id, @to_account_id, @sell_currency, @sell_minor, @buy_currency, @buy_minor,
  @rate_e8, @mid_e8, @spread_bps, @fee_minor, @created_at, @expires_at
)
RETURNING *;

-- name: GetQuote :one
SELECT * FROM fx_quotes WHERE id = @id AND user_id = @user_id;

-- name: LockQuote :one
-- Held for the whole conversion, so two requests for one quote take turns.
SELECT * FROM fx_quotes WHERE id = @id AND user_id = @user_id FOR UPDATE;

-- name: PruneQuotes :execrows
-- Expired quotes nobody converted. Converted ones stay: the conversion history needs them.
DELETE FROM fx_quotes q
WHERE q.expires_at < @before
  AND NOT EXISTS (SELECT 1 FROM fx_conversions c WHERE c.quote_id = q.id);

-- name: InsertConversion :one
INSERT INTO fx_conversions (id, user_id, quote_id, entry_id, debit_transaction_id, credit_transaction_id, created_at)
VALUES (@id, @user_id, @quote_id, @entry_id, @debit_transaction_id, @credit_transaction_id, @created_at)
RETURNING *;

-- name: GetConversionByQuote :one
SELECT id FROM fx_conversions WHERE quote_id = @quote_id;

-- name: ListConversions :many
-- The customer's conversions, newest first, keyset paged on (created_at, id).
SELECT c.id, c.quote_id, c.status, c.debit_transaction_id, c.credit_transaction_id, c.created_at,
       q.sell_currency, q.sell_minor, q.buy_currency, q.buy_minor, q.rate_e8, q.fee_minor
FROM fx_conversions c
JOIN fx_quotes q ON q.id = c.quote_id
WHERE c.user_id = @user_id
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (c.created_at, c.id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY c.created_at DESC, c.id DESC
LIMIT @row_limit;
