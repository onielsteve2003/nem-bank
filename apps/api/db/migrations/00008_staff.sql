-- +goose Up
-- Bank staff (ADM-1): a separate realm from customers, with its own table, sessions and
-- token audience. Every login needs a password and then a TOTP code; there is no way in
-- without the second factor.
CREATE TABLE staff (
  id                uuid        PRIMARY KEY,
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  email             text        NOT NULL CHECK (email = lower(email)),
  password_hash     text        NOT NULL,
  roles             text[]      NOT NULL CHECK (
                      cardinality(roles) >= 1
                      AND roles <@ ARRAY['support', 'compliance', 'finance', 'admin']::text[]),
  -- The TOTP secret, AES-256-GCM encrypted (internal/platform/fieldcrypt) and bound to
  -- this row, so a database dump alone cannot mint codes.
  totp_secret       bytea       NOT NULL,
  -- Set by the first accepted code: until then each login shows the enrolment QR.
  totp_enrolled_at  timestamptz,
  -- The last time step accepted. A code is only good for a later step, so a code seen
  -- over someone's shoulder cannot be used again (RFC 6238 §5.2).
  last_totp_counter bigint,
  last_login_at     timestamptz,
  disabled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_email ON staff (email);

-- Step 1 of a login (password accepted) waiting for step 2 (the TOTP code).
CREATE TABLE staff_login_challenges (
  id         uuid        PRIMARY KEY,
  staff_id   uuid        NOT NULL REFERENCES staff (id),
  expires_at timestamptz NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at    timestamptz
);
CREATE INDEX staff_login_challenges_staff ON staff_login_challenges (staff_id);

-- One console session per login: 8 hours, no refresh (contract StaffSession).
CREATE TABLE staff_sessions (
  id         uuid        PRIMARY KEY,
  staff_id   uuid        NOT NULL REFERENCES staff (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX staff_sessions_staff_live ON staff_sessions (staff_id) WHERE revoked_at IS NULL;

-- Maker-checker (ADM-10): one staff member proposes a sensitive change, a different one
-- approves or rejects it. The checks below hold even if the service had a bug.
CREATE TABLE approval_requests (
  id               uuid        PRIMARY KEY,
  action           text        NOT NULL CHECK (action IN
                     ('customer_unfreeze', 'limit_override', 'ledger_adjustment', 'config_change', 'dispute_refund')),
  status           text        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  maker_id         uuid        NOT NULL REFERENCES staff (id),
  checker_id       uuid        REFERENCES staff (id),
  reason           text        NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  summary          text        NOT NULL CHECK (length(summary) BETWEEN 1 AND 200),
  -- What the checker sees as a diff. IDs and values, no customer PII.
  before           jsonb,
  after            jsonb,
  rejection_reason text        CHECK (length(rejection_reason) BETWEEN 5 AND 500),
  created_at       timestamptz NOT NULL,
  decided_at       timestamptz,
  expires_at       timestamptz NOT NULL CHECK (expires_at > created_at),
  -- Four eyes: nobody approves their own request.
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  -- A decision has a checker and a time; anything else has neither.
  CHECK ((status IN ('approved', 'rejected')) = (checker_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL))
);
-- The queue: pending oldest first. Closed requests: latest first.
CREATE INDEX approval_requests_pending ON approval_requests (created_at, id) WHERE status = 'pending';
CREATE INDEX approval_requests_closed ON approval_requests (status, (coalesce(decided_at, expires_at)) DESC, id DESC)
  WHERE status <> 'pending';

-- +goose Down
DROP TABLE approval_requests;
DROP TABLE staff_sessions;
DROP TABLE staff_login_challenges;
DROP TABLE staff;
