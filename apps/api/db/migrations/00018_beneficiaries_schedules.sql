-- +goose Up
-- Beneficiaries, the new-beneficiary cooling-off, and scheduled transfers (T25.6).

-- Saved payees (TRF-8). One per account per customer. A new one cools off for a day: until
-- it has been paid or the day is over, a first transfer above the threshold waits 30
-- minutes unless the customer steps up.
CREATE TABLE beneficiaries (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id),
  kind              text        NOT NULL CHECK (kind IN ('nem', 'bank')),
  -- The name the bank holds (name enquiry), never one the customer typed.
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  nickname          text        CHECK (length(nickname) BETWEEN 1 AND 40),
  nemtag            text,
  bank_code         text        NOT NULL CHECK (bank_code ~ '^[0-9]{3,6}$'),
  bank_name         text        NOT NULL,
  account_number    text        NOT NULL CHECK (account_number ~ '^[0-9]{10}$'),
  favourite         boolean     NOT NULL DEFAULT false,
  cooling_off_until timestamptz,
  last_paid_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bank_code, account_number)
);

-- The beneficiary a transfer paid, so sending it marks them paid (and ends cooling-off).
-- When a transfer waits out the cooling-off, release_at is when it goes.
ALTER TABLE transfers ADD COLUMN beneficiary_id uuid REFERENCES beneficiaries (id) ON DELETE SET NULL;
ALTER TABLE transfers ADD CONSTRAINT transfers_delayed_release CHECK (status <> 'delayed' OR (release_at IS NOT NULL AND (duress_blocked OR hold_id IS NOT NULL)));

-- Scheduled and recurring transfers (TRF-9). Each run is a normal transfer: limits, fees
-- and cooling-off all apply. The destination is stored resolved (a Nem or bank account),
-- so deleting a beneficiary does not break a schedule paying them.
CREATE TABLE scheduled_transfers (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id),
  source_account_id uuid        NOT NULL REFERENCES customer_accounts (account_id),
  destination       jsonb       NOT NULL CHECK (destination ->> 'kind' IN ('nem', 'bank')),
  -- The contract's TransferParty, as the schedule list shows it.
  recipient         jsonb       NOT NULL CHECK (jsonb_typeof(recipient) = 'object' AND recipient ? 'name'),
  currency          text        NOT NULL CHECK (currency = 'NGN'),
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  narration         text        NOT NULL CHECK (length(narration) BETWEEN 1 AND 100),
  frequency         text        NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly', 'monthly')),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  next_run_at       timestamptz,
  ends_on           date,
  run_count         integer     NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  -- The last run as the contract's ScheduledRun: when, the transfer's status, its ID.
  last_run          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- An active schedule always has a next run; an ended one never does.
  CHECK (status <> 'active' OR next_run_at IS NOT NULL),
  CHECK (status NOT IN ('cancelled', 'completed') OR next_run_at IS NULL)
);
CREATE INDEX scheduled_transfers_user ON scheduled_transfers (user_id, created_at DESC, id DESC);
-- The runner's queue: what is due.
CREATE INDEX scheduled_transfers_due ON scheduled_transfers (next_run_at) WHERE status = 'active';

-- +goose Down
DROP TABLE scheduled_transfers;
ALTER TABLE transfers DROP CONSTRAINT transfers_delayed_release;
ALTER TABLE transfers DROP COLUMN beneficiary_id;
DROP TABLE beneficiaries;
