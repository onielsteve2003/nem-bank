-- name: UpsertIdentifier :exec
INSERT INTO kyc_identifiers (user_id, kind, ciphertext, key_version, blind_index, last4)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (user_id, kind) DO UPDATE
SET ciphertext = EXCLUDED.ciphertext, key_version = EXCLUDED.key_version,
    blind_index = EXCLUDED.blind_index, last4 = EXCLUDED.last4, updated_at = now();

-- name: GetIdentifier :one
SELECT * FROM kyc_identifiers WHERE user_id = $1 AND kind = $2;

-- name: ListIdentifiersToRewrap :many
SELECT * FROM kyc_identifiers WHERE key_version <> @current ORDER BY user_id, kind LIMIT @n;

-- name: RewrapIdentifier :execrows
-- Only if nobody re-saved the row since it was read.
UPDATE kyc_identifiers SET ciphertext = @ciphertext, key_version = @new_version, updated_at = now()
WHERE user_id = @user_id AND kind = @kind AND key_version = @old_version;
