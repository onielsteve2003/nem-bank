-- +goose Up
-- Devices bound to a customer (AUTH-6). Each holds the Ed25519 public key that signs
-- money-moving requests; the private key never leaves the phone.
CREATE TABLE devices (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id),
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  platform        text        NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  public_key      bytea       NOT NULL CHECK (length(public_key) = 32),
  hardware_backed boolean     NOT NULL DEFAULT false,
  app_version     text,
  bound_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- AUTH-8: reduced limits until this time after a login binds a new device.
  cool_off_until  timestamptz,
  revoked_at      timestamptz
);
-- A key belongs to one live device. Revoked rows keep theirs for the audit trail.
CREATE UNIQUE INDEX devices_public_key_live ON devices (public_key) WHERE revoked_at IS NULL;
CREATE INDEX devices_user ON devices (user_id) WHERE revoked_at IS NULL;

-- A session is one login on one device, and one refresh-token family: every rotation
-- stays in the session, so reuse of an old token can revoke exactly the family it came from.
CREATE TABLE sessions (
  id             uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id),
  device_id      uuid        NOT NULL REFERENCES devices (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  -- Absolute cap: rotation slides each token's expiry, never past this.
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoke_reason  text        CHECK (revoke_reason IN
                   ('logout', 'logout_all', 'device_revoked', 'session_revoked', 'token_reuse', 'replaced', 'password_reset'))
);
CREATE INDEX sessions_user_live ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_device_live ON sessions (device_id) WHERE revoked_at IS NULL;

-- Refresh tokens are opaque 256-bit values, stored as SHA-256. A used token stays as a
-- tripwire: presenting it again means it was copied, and the whole session is revoked.
CREATE TABLE refresh_tokens (
  id          uuid        PRIMARY KEY,
  session_id  uuid        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  token_hash  bytea       NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX refresh_tokens_session ON refresh_tokens (session_id);

-- +goose Down
DROP TABLE refresh_tokens;
DROP TABLE sessions;
DROP TABLE devices;
