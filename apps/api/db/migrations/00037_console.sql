-- +goose Up
-- Staff tooling (T30.5): customer freeze, notes, fraud case state, limit overrides, the bank's
-- live configuration and feature flags. Every change here is made by staff and audit-logged.

-- A frozen customer cannot sign in or move money. Staff freeze at once; unfreezing is a
-- maker-checker action (ADM-10).
ALTER TABLE users
  ADD COLUMN frozen_at     timestamptz,
  ADD COLUMN frozen_reason text CHECK (length(frozen_reason) <= 500),
  ADD CONSTRAINT users_frozen_pair CHECK ((frozen_at IS NULL) = (frozen_reason IS NULL));

CREATE TABLE staff_notes (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id),
  author_id  uuid        NOT NULL REFERENCES staff (id),
  body       text        NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_notes_user ON staff_notes (user_id, created_at DESC, id DESC);

-- A fraud case is a held transfer plus what staff did with it. The case ID is the transfer's
-- ID; a transfer nobody has touched has no row and reads as "open".
CREATE TABLE fraud_cases (
  transfer_id uuid        PRIMARY KEY REFERENCES transfers (id),
  status      text        NOT NULL CHECK (status IN ('in_review', 'released', 'rejected')),
  assignee_id uuid        REFERENCES staff (id),
  label       text        CHECK (label IN ('fraud', 'legitimate', 'unsure')),
  note        text        CHECK (length(note) <= 1000),
  customer_message text   CHECK (length(customer_message) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  CHECK ((status IN ('released', 'rejected')) = (closed_at IS NOT NULL)),
  CHECK ((status IN ('released', 'rejected')) = (label IS NOT NULL))
);
CREATE INDEX fraud_cases_open ON fraud_cases (status) WHERE closed_at IS NULL;

-- A temporary raise of one customer's daily limit above their tier, approved by a second
-- staff member (ADM-10). The limits engine takes the larger of the tier and a live override.
CREATE TABLE limit_overrides (
  id            uuid        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES users (id),
  daily_minor   bigint      NOT NULL CHECK (daily_minor > 0),
  currency      text        NOT NULL CHECK (currency = 'NGN'),
  expires_at    timestamptz NOT NULL,
  approval_id   uuid        NOT NULL REFERENCES approval_requests (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX limit_overrides_user ON limit_overrides (user_id, expires_at DESC);

-- The bank's configuration is one document with a version. A change is proposed against a
-- version; if the document moved on meanwhile, the change is stale and refused (409).
CREATE TABLE bank_config (
  id         smallint    PRIMARY KEY CHECK (id = 1),
  version    integer     NOT NULL CHECK (version >= 1),
  value      jsonb       NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flags (
  key          text        PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,59}$'),
  description  text        NOT NULL,
  enabled      boolean     NOT NULL,
  -- Needs a paid partner: switching it on is refused until an adapter is connected (PRD §11).
  paid_feature boolean     NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid        REFERENCES staff (id)
);

INSERT INTO feature_flags (key, description, enabled, paid_feature) VALUES
  ('international_transfers', 'Send money abroad (needs a licensed cross-border partner).', false, true),
  ('physical_cards', 'Order a physical debit card (needs a card printing partner).', false, true),
  ('sms_otp', 'One-time codes by SMS (needs a paid SMS provider).', false, true),
  ('real_kyc_provider', 'Real BVN and NIN verification (needs a paid identity provider).', false, true),
  ('live_bank_partner', 'Move money through a real bank partner instead of the sandbox.', false, true),
  ('nem_assistant', 'The Nem Assistant chat.', true, false),
  ('smart_categories', 'Automatic transaction categories.', true, false),
  ('ajo_groups', 'Ajo savings groups.', true, false),
  ('instant_loans', 'Instant loans from the credit hub.', true, false);

-- +goose Down
DROP TABLE feature_flags;
DROP TABLE bank_config;
DROP TABLE limit_overrides;
DROP TABLE fraud_cases;
DROP TABLE staff_notes;
ALTER TABLE users DROP CONSTRAINT users_frozen_pair, DROP COLUMN frozen_reason, DROP COLUMN frozen_at;
