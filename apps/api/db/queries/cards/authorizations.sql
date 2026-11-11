-- name: InsertAuthorization :one
INSERT INTO card_authorizations (
  id, card_id, user_id, account_id, hold_id, merchant_id, merchant_name, mcc, country, channel,
  amount_minor, amount_currency, billing_minor, billing_currency, status, decline_reason, authorized_at, expires_at
) VALUES (
  @id, @card_id, @user_id, @account_id, @hold_id, @merchant_id, @merchant_name, @mcc, @country, @channel,
  @amount_minor, @amount_currency, @billing_minor, @billing_currency, @status, @decline_reason, @authorized_at, @expires_at
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
