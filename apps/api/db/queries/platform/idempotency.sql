-- name: ClaimIdempotencyKey :one
-- Takes the key for a new request. An existing row is taken over only when it has
-- expired, or when it is the same request whose claim went stale (the server died mid
-- flight). No row back means someone else holds the key: read it with GetIdempotencyKey.
INSERT INTO idempotency_keys (scope, key, request_hash)
VALUES (@scope, @key, @request_hash)
ON CONFLICT (scope, key) DO UPDATE
SET request_hash = EXCLUDED.request_hash, status = 'in_progress', response_status = NULL,
    response_content_type = NULL, response_body = NULL, locked_at = now(), created_at = now(), completed_at = NULL
WHERE idempotency_keys.created_at < now() - make_interval(secs => sqlc.arg(retain_seconds)::float8)
   OR (idempotency_keys.status = 'in_progress'
       AND idempotency_keys.request_hash = EXCLUDED.request_hash
       AND idempotency_keys.locked_at < now() - make_interval(secs => sqlc.arg(lease_seconds)::float8))
RETURNING locked_at;

-- name: GetIdempotencyKey :one
SELECT * FROM idempotency_keys WHERE scope = $1 AND key = $2;

-- name: CompleteIdempotencyKey :execrows
UPDATE idempotency_keys
SET status = 'completed', response_status = @response_status, response_content_type = @response_content_type,
    response_body = @response_body, completed_at = now()
WHERE scope = @scope AND key = @key AND status = 'in_progress' AND locked_at = @locked_at;

-- name: ReleaseIdempotencyKey :exec
-- Frees the key after a failure the client should retry (5xx, 429).
DELETE FROM idempotency_keys
WHERE scope = @scope AND key = @key AND status = 'in_progress' AND locked_at = @locked_at;

-- name: PruneIdempotencyKeys :execrows
DELETE FROM idempotency_keys WHERE created_at < @before;
