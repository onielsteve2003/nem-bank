-- name: InsertStaff :one
INSERT INTO staff (id, name, email, password_hash, roles, totp_secret)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetStaffByEmail :one
SELECT * FROM staff WHERE email = $1;

-- name: GetStaff :one
SELECT * FROM staff WHERE id = $1;

-- name: InsertLoginChallenge :one
INSERT INTO staff_login_challenges (id, staff_id, expires_at)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetLoginChallengeForUpdate :one
SELECT * FROM staff_login_challenges WHERE id = $1 FOR UPDATE;

-- name: CountLoginChallengeAttempt :exec
UPDATE staff_login_challenges SET attempts = attempts + 1 WHERE id = $1;

-- name: UseLoginChallenge :exec
UPDATE staff_login_challenges SET used_at = @at WHERE id = $1;

-- name: PruneLoginChallenges :exec
DELETE FROM staff_login_challenges
WHERE staff_id = $1 AND (used_at IS NOT NULL OR expires_at < @before);

-- name: AcceptTotpStep :one
-- Zero rows means the step is not newer than the last one used: a replayed code.
UPDATE staff
SET last_totp_counter = @counter::bigint,
    totp_enrolled_at  = coalesce(totp_enrolled_at, @at),
    last_login_at     = @at
WHERE id = $1 AND (last_totp_counter IS NULL OR last_totp_counter < @counter::bigint)
RETURNING *;

-- name: InsertStaffSession :one
INSERT INTO staff_sessions (id, staff_id, created_at, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetStaffSession :one
SELECT sqlc.embed(staff_sessions), sqlc.embed(staff)
FROM staff_sessions JOIN staff ON staff.id = staff_sessions.staff_id
WHERE staff_sessions.id = $1;

-- name: RevokeStaffSession :exec
UPDATE staff_sessions SET revoked_at = @at WHERE id = $1 AND revoked_at IS NULL;
