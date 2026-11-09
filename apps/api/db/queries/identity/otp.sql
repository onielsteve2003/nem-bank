-- name: RecentChallengesTo :one
-- The per-address limit: how many codes were started for this email in the window, and
-- when the oldest of them leaves it (that is when the next one is allowed).
SELECT count(*)::int AS n, coalesce(min(created_at), now())::timestamptz AS oldest
FROM otp_challenges
WHERE destination = @destination AND created_at > @since::timestamptz;

-- name: InsertChallenge :one
INSERT INTO otp_challenges (id, purpose, subject_id, destination, code_hash, attempts_left,
                            expires_at, resend_available_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: GetChallengeForUpdate :one
-- Row-locked so concurrent guesses are counted one at a time.
SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE;

-- name: RecordWrongCode :exec
UPDATE otp_challenges SET attempts_left = attempts_left - 1 WHERE id = $1 AND attempts_left > 0;

-- name: MarkChallengeVerified :exec
UPDATE otp_challenges
SET verified_at = now(), token_hash = $2, token_expires_at = $3
WHERE id = $1;

-- name: ResendChallenge :one
UPDATE otp_challenges
SET code_hash = $2, attempts_left = $3, expires_at = $4, resend_available_at = $5, sends = sends + 1
WHERE id = $1
RETURNING *;

-- name: GetChallengeByTokenForUpdate :one
SELECT * FROM otp_challenges WHERE token_hash = $1 FOR UPDATE;

-- name: ConsumeChallenge :exec
UPDATE otp_challenges SET consumed_at = now() WHERE id = $1;
