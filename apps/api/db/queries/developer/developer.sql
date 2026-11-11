-- name: InsertAPIKey :exec
INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes, created_at)
VALUES (@id, @user_id, @name, @prefix, @key_hash, @scopes, @created_at);

-- name: CountLiveAPIKeys :one
SELECT count(*)::int FROM api_keys WHERE user_id = @user_id AND revoked_at IS NULL;

-- name: ListAPIKeys :many
SELECT * FROM api_keys WHERE user_id = @user_id ORDER BY created_at DESC, id DESC;

-- name: RevokeAPIKey :one
UPDATE api_keys SET revoked_at = coalesce(revoked_at, @now) WHERE id = @id AND user_id = @user_id RETURNING id;

-- name: GetLiveAPIKeyByHash :one
-- The owner must still be there and not frozen; a revoked key finds nothing.
SELECT k.id, k.user_id, k.scopes FROM api_keys k JOIN users u ON u.id = k.user_id
WHERE k.key_hash = @key_hash AND k.revoked_at IS NULL AND u.frozen_at IS NULL;

-- name: TouchAPIKey :exec
-- At most once a minute, so a busy integration does not write on every request.
UPDATE api_keys SET last_used_at = sqlc.arg(now)::timestamptz
WHERE id = sqlc.arg(id) AND (last_used_at IS NULL OR last_used_at < sqlc.arg(now)::timestamptz - interval '1 minute');

-- name: InsertEndpoint :exec
INSERT INTO webhook_endpoints (id, user_id, url, description, events, secret_prefix, secret_ciphertext, created_at)
VALUES (@id, @user_id, @url, @description, @events, @secret_prefix, @secret_ciphertext, @created_at);

-- name: CountLiveEndpoints :one
SELECT count(*)::int FROM webhook_endpoints WHERE user_id = @user_id AND deleted_at IS NULL;

-- name: ListEndpoints :many
SELECT * FROM webhook_endpoints WHERE user_id = @user_id AND deleted_at IS NULL ORDER BY created_at DESC, id DESC;

-- name: GetEndpoint :one
SELECT * FROM webhook_endpoints WHERE id = @id AND user_id = @user_id AND deleted_at IS NULL;

-- name: LockEndpoint :one
SELECT * FROM webhook_endpoints WHERE id = @id AND user_id = @user_id AND deleted_at IS NULL FOR UPDATE;

-- name: GetEndpointByID :one
-- For the delivery worker, which acts for the system, not a customer.
SELECT * FROM webhook_endpoints WHERE id = @id;

-- name: ListActiveEndpointsFor :many
SELECT * FROM webhook_endpoints
WHERE user_id = @user_id AND status = 'active' AND deleted_at IS NULL AND @event_type::text = ANY(events);

-- name: UpdateEndpoint :one
UPDATE webhook_endpoints
SET url = @url, description = @description, events = @events, status = @new_status,
    consecutive_failures = CASE WHEN status = 'disabled' AND @new_status::text = 'active' THEN 0 ELSE consecutive_failures END,
    first_failure_at = CASE WHEN status = 'disabled' AND @new_status::text = 'active' THEN NULL ELSE first_failure_at END
WHERE id = @id AND user_id = @user_id AND deleted_at IS NULL RETURNING *;

-- name: RotateSecret :one
UPDATE webhook_endpoints
SET prev_secret_ciphertext = secret_ciphertext, prev_secret_expires_at = @prev_expires_at,
    secret_ciphertext = @secret_ciphertext, secret_prefix = @secret_prefix
WHERE id = @id AND user_id = @user_id AND deleted_at IS NULL RETURNING *;

-- name: DeleteEndpoint :one
UPDATE webhook_endpoints SET deleted_at = @now WHERE id = @id AND user_id = @user_id AND deleted_at IS NULL RETURNING id;

-- name: CancelEndpointDeliveries :exec
-- A deleted endpoint receives nothing more: whatever was waiting to be sent or retried stops.
UPDATE webhook_deliveries SET status = 'failed', next_retry_at = NULL, updated_at = @now
WHERE endpoint_id = @endpoint_id AND status IN ('pending', 'retrying');

-- name: EndpointSucceeded :exec
UPDATE webhook_endpoints SET consecutive_failures = 0, first_failure_at = NULL WHERE id = @id;

-- name: EndpointFailed :one
-- Counts the failure and switches the endpoint off once it has failed for three days.
UPDATE webhook_endpoints
SET consecutive_failures = consecutive_failures + 1,
    first_failure_at = coalesce(first_failure_at, sqlc.arg(now)::timestamptz),
    status = CASE WHEN coalesce(first_failure_at, sqlc.arg(now)::timestamptz) <= sqlc.arg(now)::timestamptz - interval '3 days' THEN 'disabled' ELSE status END
WHERE id = sqlc.arg(id) RETURNING status;

-- name: InsertDelivery :one
-- The unique index makes one event reach one endpoint once; a duplicate returns no row.
INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_type, payload, original, created_at, updated_at)
VALUES (@id, @endpoint_id, @event_id, @event_type, @payload, @original, @now, @now)
ON CONFLICT (endpoint_id, event_id) WHERE original DO NOTHING
RETURNING *;

-- name: GetDelivery :one
SELECT d.* FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
WHERE d.id = @id AND e.user_id = @user_id AND e.deleted_at IS NULL;

-- name: GetDeliveryForUpdate :one
SELECT * FROM webhook_deliveries WHERE id = @id FOR UPDATE;

-- name: ListDeliveries :many
SELECT * FROM webhook_deliveries
WHERE endpoint_id = @endpoint_id AND (@status::text = '' OR status = @status::text)
  AND (created_at, id) < (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at DESC, id DESC LIMIT @page_size;

-- name: RecordAttempt :exec
UPDATE webhook_deliveries
SET status = @status, attempt = @attempt, response_status = @response_status, response_excerpt = @response_excerpt,
    duration_ms = @duration_ms, next_retry_at = @next_retry_at, updated_at = @now
WHERE id = @id;
