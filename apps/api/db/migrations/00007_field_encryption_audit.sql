-- +goose Up
-- BVN, NIN and ID document numbers (T23.6), encrypted per field with AES-256-GCM
-- (internal/platform/fieldcrypt). The ciphertext is bound to its owner and kind, so it
-- cannot be moved to another row. blind_index is an HMAC for "is this BVN already used?"
-- without decrypting; last4 is what screens show ("•••• 5678").
CREATE TABLE kyc_identifiers (
  user_id     uuid        NOT NULL REFERENCES users (id),
  kind        text        NOT NULL CHECK (kind IN ('bvn', 'nin', 'id_document')),
  ciphertext  bytea       NOT NULL,
  -- Copied from the ciphertext header so a rotation can find the rows still on an old key.
  key_version integer     NOT NULL CHECK (key_version BETWEEN 1 AND 65535),
  blind_index bytea       NOT NULL CHECK (length(blind_index) = 32),
  last4       text        NOT NULL CHECK (length(last4) = 4),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);
-- One customer per BVN and per NIN (CBN: one BVN, one person). ID documents can repeat
-- across kinds of document, so they are not unique here.
CREATE UNIQUE INDEX kyc_identifiers_one_owner ON kyc_identifiers (kind, blind_index)
  WHERE kind IN ('bvn', 'nin');
CREATE INDEX kyc_identifiers_key_version ON kyc_identifiers (key_version);

-- Tamper-evident audit log (ADM-9). Each row's hash is SHA-256 over the previous row's
-- hash and the row's canonical JSON (internal/audit), so editing or deleting any row
-- breaks every hash after it. The triggers make the table append-only for the app's role;
-- someone with the power to drop them is exactly who the hash chain exposes.
CREATE TABLE audit_log (
  seq           bigint      PRIMARY KEY CHECK (seq >= 1),
  id            uuid        NOT NULL UNIQUE,
  at            timestamptz NOT NULL,
  actor_type    text        NOT NULL CHECK (actor_type IN ('staff', 'customer', 'system')),
  actor_id      text,
  actor_name    text,
  action        text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  resource_type text        NOT NULL,
  resource_id   text        NOT NULL,
  -- IDs only, never PII (contract AuditEntry.metadata).
  metadata      jsonb       NOT NULL DEFAULT '{}',
  ip            text,
  prev_hash     text        NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash          text        NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX audit_log_resource ON audit_log (resource_type, resource_id, seq);
CREATE INDEX audit_log_actor ON audit_log (actor_type, actor_id, seq);

-- +goose StatementBegin
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END
$$;
-- +goose StatementEnd
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

-- +goose Down
DROP TABLE audit_log;
DROP FUNCTION audit_log_append_only();
DROP TABLE kyc_identifiers;
