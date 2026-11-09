-- +goose Up
-- The sandbox interbank rail (T25.3). SandboxNIP stands in for NIBSS Instant Payment: it
-- accepts payments, settles or fails them after a delay, and calls back like a real
-- partner. Its state lives here, not in memory, so a restart never loses a payment that is
-- still "at the other bank".

-- Settings staff change from the console's Bank Partner Simulator (contract
-- BankPartnerSimulator). One row per simulator.
CREATE TABLE simulator_settings (
  name       text        PRIMARY KEY CHECK (name IN ('bank_partner')),
  settings   jsonb       NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        REFERENCES staff (id)
);
-- The console's defaults: mostly fast and successful, with enough failures to demo
-- auto-reversal.
INSERT INTO simulator_settings (name, settings) VALUES
  ('bank_partner', '{"failure_rate_bps": 200, "min_delay_seconds": 1, "max_delay_seconds": 8, "name_check": "realistic", "timeout_rate_bps": 50}');

-- What the sandbox "bank" received. The outcome is drawn when the payment arrives and only
-- shows once settle_at has passed, so a status query and the callback always agree.
CREATE TABLE sandbox_nip_payments (
  -- Nem's reference: a resend of the same reference is the same payment.
  reference         text        PRIMARY KEY CHECK (length(reference) BETWEEN 1 AND 64),
  -- The session ID NIBSS would assign.
  partner_reference text        NOT NULL UNIQUE,
  bank_code         text        NOT NULL,
  account_number    text        NOT NULL CHECK (account_number ~ '^[0-9]{10}$'),
  currency          text        NOT NULL CHECK (currency = 'NGN'),
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  outcome           text        NOT NULL CHECK (outcome IN ('settled', 'failed', 'timeout')),
  -- NIP response codes for a failure, e.g. 51 (no funds at the partner), 57 (not permitted).
  failure_code      text,
  received_at       timestamptz NOT NULL DEFAULT now(),
  settle_at         timestamptz NOT NULL,
  -- Set once the receiver acknowledged the callback; a timeout never calls back.
  callback_sent_at  timestamptz,
  CHECK ((outcome = 'failed') = (failure_code IS NOT NULL)),
  CHECK (settle_at >= received_at),
  CHECK (outcome <> 'timeout' OR callback_sent_at IS NULL)
);

-- +goose Down
DROP TABLE sandbox_nip_payments;
DROP TABLE simulator_settings;
