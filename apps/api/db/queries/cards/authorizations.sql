-- name: InsertAuthorization :one
INSERT INTO card_authorizations (
  id, card_id, user_id, account_id, hold_id, merchant_id, merchant_name, mcc, country, channel,
  amount_minor, amount_currency, billing_minor, billing_currency, status, decline_reason, transaction_id, authorized_at, expires_at
) VALUES (
  @id, @card_id, @user_id, @account_id, @hold_id, @merchant_id, @merchant_name, @mcc, @country, @channel,
  @amount_minor, @amount_currency, @billing_minor, @billing_currency, @status, @decline_reason, @transaction_id, @authorized_at, @expires_at
)
RETURNING *;

-- name: SpendSince :one
-- What the card has been charged since a moment: approved authorizations and settled ones.
-- Declined and reversed attempts never count against a limit.
SELECT COALESCE(SUM(billing_minor), 0)::bigint AS spent FROM card_authorizations
WHERE card_id = @card_id AND status IN ('authorized', 'settled') AND authorized_at >= @since;

-- name: CountCharges :one
-- Charges that count against a single-use card: approved and settled.
SELECT count(*) FROM card_authorizations WHERE card_id = @card_id AND status IN ('authorized', 'settled');

-- name: GetAuthorization :one
SELECT * FROM card_authorizations WHERE id = @id;

-- name: LockAuthorization :one
-- Serialises capture, reversal and expiry of one authorization (taken after the card's lock).
SELECT * FROM card_authorizations WHERE id = @id FOR UPDATE;

-- name: CloseAuthorization :one
-- Settles or reverses an authorization. A capture may be for less than was authorized, so
-- the amounts are the final ones.
UPDATE card_authorizations
SET status = @status, amount_minor = @amount_minor, billing_minor = @billing_minor, settled_at = @settled_at
WHERE id = @id
RETURNING *;

-- name: ListCardAuthorizations :many
-- One card's attempts, newest first, by keyset.
SELECT * FROM card_authorizations
WHERE card_id = @card_id AND user_id = @user_id
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (authorized_at, id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY authorized_at DESC, id DESC
LIMIT @lim;

-- name: ListDueAuthorizations :many
-- Approved authorizations whose hold has lapsed and was never settled.
SELECT id FROM card_authorizations
WHERE status = 'authorized' AND expires_at <= @now
ORDER BY expires_at
LIMIT @lim;
