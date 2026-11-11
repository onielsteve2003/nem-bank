-- name: InsertNotification :one
-- Returns the new row, or no row when this (customer, event, role) was already delivered.
INSERT INTO notifications (id, user_id, category, title, body, deep_link, dedupe_key, created_at)
VALUES (@id, @user_id, @category, @title, @body, @deep_link, @dedupe_key, @created_at)
ON CONFLICT (user_id, dedupe_key) DO NOTHING
RETURNING *;

-- name: ListNotifications :many
-- The first page passes a point after every row (year 9999, the largest UUID).
SELECT * FROM notifications
WHERE user_id = @user_id
  AND (NOT @unread_only::boolean OR read_at IS NULL)
  AND (created_at, id) < (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at DESC, id DESC
LIMIT @page_size;

-- name: CountUnread :one
SELECT count(*) FROM notifications WHERE user_id = @user_id AND read_at IS NULL;

-- name: MarkRead :exec
UPDATE notifications SET read_at = @now
WHERE user_id = @user_id AND read_at IS NULL AND id = ANY(@ids::uuid[]);

-- name: MarkAllRead :exec
UPDATE notifications SET read_at = @now WHERE user_id = @user_id AND read_at IS NULL;

-- name: GetPreferences :one
SELECT categories FROM notification_preferences WHERE user_id = @user_id;

-- name: SetPreferences :exec
INSERT INTO notification_preferences (user_id, categories, updated_at)
VALUES (@user_id, @categories, @now)
ON CONFLICT (user_id) DO UPDATE SET categories = EXCLUDED.categories, updated_at = EXCLUDED.updated_at;

-- name: UpsertPushToken :execrows
-- The device must be the caller's and not revoked: a token for someone else's device is refused.
INSERT INTO push_tokens (device_id, user_id, expo_push_token, created_at)
SELECT d.id, d.user_id, @token, @now FROM devices d WHERE d.id = @device_id AND d.user_id = @user_id AND d.revoked_at IS NULL
ON CONFLICT (device_id) DO UPDATE SET expo_push_token = EXCLUDED.expo_push_token, created_at = EXCLUDED.created_at;

-- name: DeletePushToken :exec
DELETE FROM push_tokens WHERE device_id = @device_id AND user_id = @user_id;

-- name: DeletePushTokenByValue :exec
DELETE FROM push_tokens WHERE expo_push_token = @token;

-- name: ListPushTokens :many
SELECT expo_push_token FROM push_tokens WHERE user_id = @user_id;

-- name: GetEmail :one
SELECT email FROM users WHERE id = @user_id;
