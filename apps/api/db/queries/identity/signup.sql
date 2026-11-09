-- name: EmailOrPhoneTaken :one
SELECT
  EXISTS (SELECT 1 FROM users u WHERE u.email = @email::text) AS email_taken,
  EXISTS (SELECT 1 FROM users u WHERE u.phone = @phone::text) AS phone_taken;

-- name: InsertSignup :exec
INSERT INTO signups (id, first_name, last_name, email, phone, date_of_birth,
                     terms_version, privacy_version, consent_accepted_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: GetSignupForUpdate :one
SELECT * FROM signups WHERE id = $1 FOR UPDATE;

-- name: CompleteSignup :exec
UPDATE signups SET completed_at = now(), user_id = $2 WHERE id = $1;

-- name: InsertUser :one
INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth, password_hash,
                   terms_version, privacy_version, consent_accepted_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: GetSignup :one
SELECT * FROM signups WHERE id = $1;
