-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: GetUserByPhone :one
SELECT * FROM users WHERE phone = $1;

-- name: InsertDevice :one
INSERT INTO devices (id, user_id, name, platform, public_key, hardware_backed, app_version, cool_off_until)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: GetLiveDeviceByKey :one
SELECT * FROM devices WHERE public_key = $1 AND revoked_at IS NULL;

-- name: GetLiveDevice :one
SELECT * FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL;

-- name: TouchDevice :one
UPDATE devices SET last_seen_at = now() WHERE id = $1 RETURNING *;

-- name: ListLiveDevices :many
SELECT * FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY bound_at, id;

-- name: RevokeDevice :execrows
UPDATE devices SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL;

-- name: InsertSession :one
INSERT INTO sessions (id, user_id, device_id, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetSession :one
SELECT * FROM sessions WHERE id = $1;

-- name: TouchSession :exec
UPDATE sessions SET last_active_at = now() WHERE id = $1;

-- name: RevokeSession :execrows
UPDATE sessions SET revoked_at = now(), revoke_reason = @reason
WHERE id = @id AND user_id = @user_id AND revoked_at IS NULL;

-- name: RevokeDeviceSessions :exec
UPDATE sessions SET revoked_at = now(), revoke_reason = @reason
WHERE device_id = @device_id AND revoked_at IS NULL;

-- name: RevokeUserSessions :exec
UPDATE sessions SET revoked_at = now(), revoke_reason = @reason
WHERE user_id = @user_id AND revoked_at IS NULL;

-- name: ListLiveSessions :many
SELECT s.id, s.device_id, d.name AS device_name, s.created_at, s.last_active_at
FROM sessions s JOIN devices d ON d.id = s.device_id
WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
ORDER BY s.last_active_at DESC, s.id;

-- name: InsertRefreshToken :exec
INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at)
VALUES ($1, $2, $3, $4);

-- name: GetRefreshTokenForUpdate :one
-- Locked so two refreshes with the same token are decided one at a time: exactly one
-- rotates, the other sees used_at and is treated as reuse.
SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE;

-- name: MarkRefreshTokenUsed :exec
UPDATE refresh_tokens SET used_at = now() WHERE id = $1;
