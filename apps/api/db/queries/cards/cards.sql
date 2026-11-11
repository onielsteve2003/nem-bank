-- name: InsertCard :one
INSERT INTO cards (
  id, user_id, account_id, currency, type, network, last4, pan_enc, pan_index, expiry_month, expiry_year,
  name_on_card, nickname, design, spend_limit_minor, spend_limit_period, online_enabled, international_enabled,
  merchant_id, merchant_name, created_at
) VALUES (
  @id, @user_id, @account_id, @currency, @type, @network, @last4, @pan_enc, @pan_index, @expiry_month, @expiry_year,
  @name_on_card, @nickname, @design, @spend_limit_minor, @spend_limit_period, @online_enabled, @international_enabled,
  @merchant_id, @merchant_name, @created_at
)
RETURNING *;

-- name: LockUserCards :exec
-- Serialises card issuing per customer, so two racing requests cannot both take the last slot.
SELECT pg_advisory_xact_lock(hashtextextended('cards:' || @user_id::text, 0));

-- name: CountLiveCards :one
SELECT count(*) FROM cards WHERE user_id = @user_id AND status IN ('active', 'frozen');

-- name: PanIndexTaken :one
SELECT EXISTS (SELECT 1 FROM cards WHERE pan_index = @pan_index);

-- name: GetCard :one
SELECT * FROM cards WHERE id = @id AND user_id = @user_id;

-- name: ListCards :many
-- Terminated cards last, then newest first.
SELECT * FROM cards WHERE user_id = @user_id
ORDER BY (status = 'terminated'), created_at DESC, id DESC;

-- name: GetCardByPanIndex :one
-- The processor's lookup: the merchant sends a number, never an ID.
SELECT * FROM cards WHERE pan_index = @pan_index;

-- name: LockCard :one
-- Serialises everything that decides on one card (authorizations, controls, termination).
SELECT * FROM cards WHERE id = @id FOR UPDATE;

-- name: UpdateCardControls :one
UPDATE cards
SET nickname = @nickname, spend_limit_minor = @spend_limit_minor, spend_limit_period = @spend_limit_period,
    online_enabled = @online_enabled, international_enabled = @international_enabled,
    merchant_id = @merchant_id, merchant_name = @merchant_name
WHERE id = @id
RETURNING *;

-- name: SetCardStatus :one
UPDATE cards
SET status = @status, frozen_by_panic = @frozen_by_panic, terminated_at = @terminated_at
WHERE id = @id
RETURNING *;
