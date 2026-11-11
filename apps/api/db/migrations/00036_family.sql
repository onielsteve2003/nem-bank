-- +goose Up
-- Family (FAM-1..3): a parent adds a dependant who has their own user row, NGN account and
-- @nemtag, under the parent's controls.

-- A dependant is a user whose email and phone are the guardian's contact details (a child has
-- neither, and codes and alerts about the child go to the person responsible for them). Two
-- users may therefore share one email or phone, so the unique indexes cover only people who sign
-- in with them; a dependant is never found by email or phone (their @nemtag and account number
-- still work). A dependant cannot sign in with a password: the placeholder hash matches nothing.
ALTER TABLE users
  ADD COLUMN is_dependant boolean NOT NULL DEFAULT false,
  ADD COLUMN guardian_id  uuid    REFERENCES users (id),
  ADD CONSTRAINT users_guardian_matches CHECK (is_dependant = (guardian_id IS NOT NULL));

DROP INDEX users_email_key;
DROP INDEX users_phone_key;
CREATE UNIQUE INDEX users_email_key ON users (email) WHERE NOT is_dependant;
CREATE UNIQUE INDEX users_phone_key ON users (phone) WHERE NOT is_dependant;
CREATE INDEX users_guardian ON users (guardian_id) WHERE guardian_id IS NOT NULL;

CREATE TABLE dependants (
  id                         uuid        PRIMARY KEY,
  guardian_id                uuid        NOT NULL REFERENCES users (id),
  user_id                    uuid        NOT NULL UNIQUE REFERENCES users (id),
  account_id                 uuid        NOT NULL REFERENCES customer_accounts (account_id),
  kid_mode                   boolean     NOT NULL DEFAULT true,
  -- The parent's controls (FAM-2), all naira.
  daily_spend_limit_minor    bigint      NOT NULL CHECK (daily_spend_limit_minor > 0),
  approval_threshold_minor   bigint      NOT NULL CHECK (approval_threshold_minor > 0),
  can_send_to_banks          boolean     NOT NULL,
  paused                     boolean     NOT NULL DEFAULT false,
  -- The code the child types on their own device. Kept only as an HMAC under a server key: eight
  -- digits are trivial to brute force from a plain hash.
  setup_code_hash            bytea,
  setup_code_expires_at      timestamptz,
  -- The allowance: a recurring transfer from the parent's account.
  allowance_amount_minor     bigint      CHECK (allowance_amount_minor > 0),
  allowance_frequency        text        CHECK (allowance_frequency IN ('weekly', 'monthly')),
  allowance_day              smallint    CHECK (allowance_day BETWEEN 1 AND 28),
  allowance_source_account_id uuid       REFERENCES customer_accounts (account_id),
  allowance_next_run_at      timestamptz,
  created_at                 timestamptz NOT NULL,
  CHECK ((allowance_amount_minor IS NULL) = (allowance_frequency IS NULL)
     AND (allowance_amount_minor IS NULL) = (allowance_source_account_id IS NULL)
     AND (allowance_amount_minor IS NULL) = (allowance_next_run_at IS NULL)
     AND (allowance_amount_minor IS NULL) = (allowance_day IS NULL))
);
CREATE INDEX dependants_guardian ON dependants (guardian_id, created_at, id);
CREATE INDEX dependants_allowance_due ON dependants (allowance_next_run_at) WHERE allowance_next_run_at IS NOT NULL;

-- A dependant's transfer above their threshold waits here for the guardian. The money is set
-- aside by a ledger hold from the moment it is asked for, so approving cannot fail for lack of
-- funds and declining or expiry gives it back.
CREATE TABLE family_approvals (
  id                uuid        PRIMARY KEY,
  dependant_id      uuid        NOT NULL REFERENCES dependants (id),
  guardian_id       uuid        NOT NULL REFERENCES users (id),
  user_id           uuid        NOT NULL REFERENCES users (id),
  source_account_id uuid        NOT NULL,
  -- The request as the child sent it (contract TransferDestination), replayed on approval.
  destination       jsonb       NOT NULL,
  -- Who is paid, as the guardian sees it (contract TransferParty).
  recipient         jsonb       NOT NULL,
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  narration         text        NOT NULL,
  category          text,
  status            text        NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  hold_id           uuid,
  transfer_id       uuid        REFERENCES transfers (id),
  created_at        timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  decided_at        timestamptz,
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK ((status = 'approved') = (transfer_id IS NOT NULL))
);
CREATE INDEX family_approvals_guardian ON family_approvals (guardian_id, status, created_at DESC, id DESC);
CREATE INDEX family_approvals_dependant ON family_approvals (user_id, created_at DESC, id DESC);
CREATE INDEX family_approvals_expiry ON family_approvals (expires_at) WHERE status = 'pending';

-- +goose Down
DROP TABLE family_approvals;
DROP TABLE dependants;
DROP INDEX users_guardian;
DROP INDEX users_phone_key;
DROP INDEX users_email_key;
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_phone_key ON users (phone);
ALTER TABLE users
  DROP CONSTRAINT users_guardian_matches,
  DROP COLUMN guardian_id,
  DROP COLUMN is_dependant;
