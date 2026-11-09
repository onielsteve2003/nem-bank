-- name: LockAuditChain :exec
-- Appends are serialised for the rest of the transaction: each needs the head's hash.
SELECT pg_advisory_xact_lock(7123001);

-- name: GetAuditHead :one
SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1;

-- name: InsertAuditEntry :exec
INSERT INTO audit_log (seq, id, at, actor_type, actor_id, actor_name, action, resource_type,
  resource_id, metadata, ip, prev_hash, hash)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13);

-- name: GetAuditHash :one
SELECT hash FROM audit_log WHERE seq = $1;

-- name: ListAuditRange :many
SELECT * FROM audit_log WHERE seq >= @from_seq AND seq <= @to_seq ORDER BY seq LIMIT @n;
