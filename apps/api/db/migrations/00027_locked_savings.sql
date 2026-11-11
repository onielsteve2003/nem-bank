-- +goose Up
-- Locked savings (FR-SAV SAV-4, SAV-5, T28.3). Each lock keeps its principal in its own
-- ledger account, so a customer can hold several at once; the one-per-kind rule that
-- 00009 gave customer accounts is lifted for locks, as it already was for savings goals.
DROP INDEX ledger_accounts_customer;
CREATE UNIQUE INDEX ledger_accounts_customer ON ledger_accounts (owner_id, kind, currency)
  WHERE owner_type = 'customer' AND kind NOT IN ('customer_savings', 'customer_locked');

CREATE TABLE locked_savings (
  id                       uuid        PRIMARY KEY,
  user_id                  uuid        NOT NULL REFERENCES users (id),
  account_id               uuid        NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  principal_minor          bigint      NOT NULL CHECK (principal_minor > 0),
  term_days                integer     NOT NULL CHECK (term_days BETWEEN 30 AND 365),
  -- The rate and the penalty are fixed when the customer locks, whatever the table says later.
  rate_bps                 integer     NOT NULL CHECK (rate_bps > 0),
  early_break_penalty_bps  integer     NOT NULL CHECK (early_break_penalty_bps BETWEEN 0 AND 10000),
  start_date               date        NOT NULL,
  maturity_date            date        NOT NULL,
  -- What the whole term pays, priced at the start: the maturity payout and the disclosure.
  expected_interest_minor  bigint      NOT NULL CHECK (expected_interest_minor >= 0),
  -- Interest posted to the lock's ledger account so far, and the day count it covers
  -- (SAV-5). Always the closed-form figure for accrued_days, never a running sum of
  -- rounded days, so it ends exactly at expected_interest_minor.
  accrued_interest_minor   bigint      NOT NULL DEFAULT 0 CHECK (accrued_interest_minor >= 0),
  accrued_days             integer     NOT NULL DEFAULT 0 CHECK (accrued_days BETWEEN 0 AND 365),
  status                   text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'matured', 'broken')),
  -- What reached the customer's naira account: principal plus the interest they kept.
  paid_out_minor           bigint      CHECK (paid_out_minor >= 0),
  ended_at                 timestamptz,
  created_at               timestamptz NOT NULL,
  CHECK (maturity_date = start_date + term_days),
  CHECK (accrued_days <= term_days),
  CHECK (accrued_interest_minor <= expected_interest_minor),
  CHECK ((status = 'active') = (paid_out_minor IS NULL)),
  CHECK ((status = 'active') = (ended_at IS NULL))
);
CREATE INDEX locked_savings_user ON locked_savings (user_id, start_date DESC, id DESC);
-- The daily sweep reads only locks still running.
CREATE INDEX locked_savings_active ON locked_savings (maturity_date) WHERE status = 'active';

-- +goose Down
DROP TABLE locked_savings;
DROP INDEX ledger_accounts_customer;
CREATE UNIQUE INDEX ledger_accounts_customer ON ledger_accounts (owner_id, kind, currency)
  WHERE owner_type = 'customer' AND kind <> 'customer_savings';
