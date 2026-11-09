-- +goose Up
-- Official statements (ACC-8) and end-of-day balances.

-- A posting's time is when it was written, not when its transaction began. The posting
-- engine writes postings only while holding the account's row lock, so clock time then
-- follows the order the balances changed in; now() (the transaction's start) would not,
-- and "the balance at midnight" could read an older balance than the latest one.
ALTER TABLE postings ALTER COLUMN created_at SET DEFAULT clock_timestamp();

CREATE TABLE statements (
  id                    uuid        PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id),
  account_id            uuid        NOT NULL REFERENCES customer_accounts (account_id),
  currency              text        NOT NULL,
  -- Lagos calendar days, inclusive at both ends, up to 12 months (@nem/shared statement.ts).
  period_from           date        NOT NULL,
  period_to             date        NOT NULL,
  status                text        NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'ready', 'failed')),
  opening_balance_minor bigint,
  closing_balance_minor bigint,
  -- SHA-256 of the statement's canonical content (account, period, balances and every
  -- line), printed on each page; the public verification page shows it to compare.
  sha256                text        CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  verification_code     text        UNIQUE CHECK (verification_code ~ '^[A-Z0-9]{12}$'),
  -- The PDF exactly as issued, so a download is always the document that was verified.
  pdf                   bytea,
  created_at            timestamptz NOT NULL DEFAULT now(),
  ready_at              timestamptz,
  CHECK (period_from <= period_to),
  CHECK ((status = 'ready') = (pdf IS NOT NULL AND sha256 IS NOT NULL AND verification_code IS NOT NULL
         AND opening_balance_minor IS NOT NULL AND closing_balance_minor IS NOT NULL AND ready_at IS NOT NULL))
);
CREATE INDEX statements_user ON statements (user_id, created_at DESC, id DESC);

-- Each customer account's ledger balance at the end of each Lagos day, for insights,
-- reconciliation and quick statement openings. Written once per day by a catch-up job.
CREATE TABLE daily_balances (
  account_id    uuid        NOT NULL REFERENCES customer_accounts (account_id),
  as_of         date        NOT NULL,
  balance_minor bigint      NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, as_of)
);

-- +goose Down
DROP TABLE daily_balances;
DROP TABLE statements;
ALTER TABLE postings ALTER COLUMN created_at SET DEFAULT now();
