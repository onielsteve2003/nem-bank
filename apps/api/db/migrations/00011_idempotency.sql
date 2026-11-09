-- +goose Up
-- Idempotency keys for money-moving POSTs (TRF-5, architecture §4). The app sends one
-- UUIDv7 per intent; a retry with the same key gets the first response back instead of
-- running again, and the same key with a different request is refused (422).
CREATE TABLE idempotency_keys (
  -- Whose key it is: 'user:<id>', 'staff:<id>' or 'public'. Two callers can never see
  -- each other's responses, even if they sent the same key.
  scope                 text        NOT NULL CHECK (length(scope) BETWEEN 1 AND 100),
  key                   uuid        NOT NULL,
  -- SHA-256 of method, target and body bytes, as the client sent them.
  request_hash          bytea       NOT NULL CHECK (length(request_hash) = 32),
  status                text        NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status       integer,
  response_content_type text,
  response_body         bytea,
  -- The claim's lease: a request that died mid-flight frees its key once this is old
  -- enough, and only the claim holding this exact value may finish or drop the row.
  locked_at             timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  PRIMARY KEY (scope, key),
  CHECK ((status = 'completed') = (response_status IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- +goose Down
DROP TABLE idempotency_keys;
