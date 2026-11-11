-- +goose Up
-- Privacy (T30.7, SET-5, NDPA 2023): data export and account deletion.

-- An erased customer keeps their users row (the ledger and audit log point at it) but nothing in
-- it identifies them any more.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;

-- Erased accounts get a unique placeholder phone number, which has to look like a real one (the
-- column's check) and still be unique. 8 digits allow a hundred million erasures.
CREATE SEQUENCE erased_phone_seq MINVALUE 1 MAXVALUE 99999999;

CREATE TABLE privacy_requests (
  id               uuid        PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES users (id),
  kind             text        NOT NULL CHECK (kind IN ('export', 'deletion')),
  status           text        NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'completed', 'rejected')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  -- The promise made to the customer (NDPA: within 30 days); the jobs normally finish in minutes.
  completes_by     timestamptz NOT NULL,
  completed_at     timestamptz,
  rejection_reason text,
  CHECK ((status IN ('completed', 'rejected')) = (completed_at IS NOT NULL))
);
CREATE INDEX privacy_requests_user ON privacy_requests (user_id, kind, requested_at DESC);

-- A finished archive waits here, encrypted (AES-256-GCM bound to the request), until the customer
-- downloads it once or a week passes. Nothing about its contents is in any other table.
CREATE TABLE privacy_exports (
  request_id uuid        PRIMARY KEY REFERENCES privacy_requests (id),
  user_id    uuid        NOT NULL REFERENCES users (id),
  ciphertext bytea       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- +goose Down
DROP TABLE privacy_exports;
DROP TABLE privacy_requests;
DROP SEQUENCE erased_phone_seq;
ALTER TABLE users DROP COLUMN deleted_at;
