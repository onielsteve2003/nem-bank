-- name: GetLiveDeviceByID :one
SELECT * FROM devices WHERE id = $1 AND revoked_at IS NULL;

-- name: PruneDeviceNonces :exec
DELETE FROM signed_request_nonces WHERE device_id = $1 AND expires_at < @before;

-- name: InsertNonce :execrows
-- Zero rows means the nonce was already used: a replay.
INSERT INTO signed_request_nonces (device_id, nonce, expires_at)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: PruneDeviceChallenges :exec
DELETE FROM device_challenges
WHERE device_id = $1 AND (used_at IS NOT NULL OR expires_at < @before);

-- name: InsertDeviceChallenge :one
INSERT INTO device_challenges (id, device_id, nonce, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetDeviceChallengeForUpdate :one
SELECT * FROM device_challenges WHERE id = $1 FOR UPDATE;

-- name: UseDeviceChallenge :exec
UPDATE device_challenges SET used_at = now() WHERE id = $1;
