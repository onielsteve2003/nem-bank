-- name: GetUserForUpdate :one
-- PIN checks lock the user row, so parallel guesses are counted one at a time.
SELECT * FROM users WHERE id = $1 FOR UPDATE;

-- name: SetPinHash :exec
UPDATE users
SET pin_hash = $2, pin_failures = 0, pin_lockouts = 0, pin_locked_until = NULL
WHERE id = $1;

-- name: RecordPinFailure :exec
UPDATE users SET pin_failures = $2, pin_lockouts = $3, pin_locked_until = $4 WHERE id = $1;

-- name: RecordPinSuccess :exec
-- duress_since is set on a duress PIN and cleared by the real one.
UPDATE users
SET pin_failures = 0, pin_lockouts = 0, pin_locked_until = NULL, duress_since = $2
WHERE id = $1;

-- name: SetDuressPinHash :exec
UPDATE users SET duress_pin_hash = $2 WHERE id = $1;

-- name: GetDuressSince :one
SELECT duress_since FROM users WHERE id = $1;

-- name: GetStepUpChallengeByTokenForUpdate :one
SELECT * FROM otp_challenges WHERE token_hash = $1 AND purpose = 'step_up' FOR UPDATE;
