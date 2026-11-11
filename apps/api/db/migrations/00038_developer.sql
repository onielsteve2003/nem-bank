-- +goose Up
-- The developer platform (T30.6, DEV-1 to DEV-4): API keys, outbound webhook endpoints and the
-- delivery log. Everything here belongs to one customer (a business using the sandbox).

-- A key is shown once; only its SHA-256 is stored. Keys are random 190-bit strings, so a fast
-- hash is enough (nothing to brute-force), and it lets a request find its key by one lookup.
CREATE TABLE api_keys (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id),
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  prefix       text        NOT NULL CHECK (length(prefix) = 13),
  key_hash     bytea       NOT NULL UNIQUE CHECK (length(key_hash) = 32),
  scopes       text[]      NOT NULL CHECK (cardinality(scopes) >= 1 AND scopes <@ ARRAY[
                 'accounts_read', 'transactions_read', 'transfers_read', 'payment_links_write', 'webhooks_manage']::text[]),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX api_keys_user ON api_keys (user_id, created_at DESC, id DESC);

CREATE TABLE webhook_endpoints (
  id                     uuid        PRIMARY KEY,
  user_id                uuid        NOT NULL REFERENCES users (id),
  url                    text        NOT NULL CHECK (url ~ '^https://' AND length(url) <= 500),
  description            text        CHECK (length(description) <= 100),
  events                 text[]      NOT NULL CHECK (cardinality(events) >= 1),
  -- Endpoints go quiet by themselves after three days of failures (the contract's rule).
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  secret_prefix          text        NOT NULL,
  -- The signing secret has to be readable to sign, so it is encrypted (AES-256-GCM, bound to
  -- this row), unlike an API key, which is only ever compared.
  secret_ciphertext      bytea       NOT NULL,
  -- After a rotation the old secret keeps signing next to the new one for 24 hours.
  prev_secret_ciphertext bytea,
  prev_secret_expires_at timestamptz,
  consecutive_failures   integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  first_failure_at       timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CHECK ((prev_secret_ciphertext IS NULL) = (prev_secret_expires_at IS NULL))
);
CREATE INDEX webhook_endpoints_user ON webhook_endpoints (user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- One row per (event, endpoint): attempts update it, so the log shows each event's journey. A
-- replay is a new row for the same event (same event_id, so receivers can deduplicate).
CREATE TABLE webhook_deliveries (
  id              uuid        PRIMARY KEY,
  endpoint_id     uuid        NOT NULL REFERENCES webhook_endpoints (id),
  event_id        uuid        NOT NULL,
  event_type      text        NOT NULL,
  -- The exact body that is POSTed, so a retry or a replay sends the same bytes.
  payload         jsonb       NOT NULL,
  attempt         integer     NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 8),
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'retrying', 'failed')),
  response_status integer,
  response_excerpt text       CHECK (length(response_excerpt) <= 500),
  duration_ms     integer,
  next_retry_at   timestamptz,
  -- Set on the original delivery of an event; a replay has none, so one event is delivered to
  -- one endpoint once even if the outbox hands it over twice.
  original        boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries (endpoint_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX webhook_deliveries_once ON webhook_deliveries (endpoint_id, event_id) WHERE original;

-- +goose Down
DROP TABLE webhook_deliveries;
DROP TABLE webhook_endpoints;
DROP TABLE api_keys;
