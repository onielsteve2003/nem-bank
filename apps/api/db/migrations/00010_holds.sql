-- +goose Up
-- Holds (ACC-3): money set aside for a card authorisation or a pending external transfer.
-- A hold lowers the account's available balance but not its ledger balance; it ends by
-- being released (the money is spendable again) or captured by the entry that moves it.
-- The posting engine keeps ledger_accounts.available_minor = balance_minor minus the
-- active holds, under the account's row lock.
CREATE TABLE account_holds (
  id           uuid        PRIMARY KEY,
  account_id   uuid        NOT NULL,
  currency     text        NOT NULL,
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  -- What the hold is for: a transfer ID, a card authorisation.
  reference    text        NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'captured')),
  -- The entry that moved the held money, for a captured hold.
  entry_id     uuid        REFERENCES journal_entries (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  -- Same trick as postings: a hold in dollars can never sit on a naira account.
  FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency),
  CHECK ((status = 'active') = (closed_at IS NULL)),
  CHECK ((status = 'captured') = (entry_id IS NOT NULL))
);
CREATE INDEX account_holds_active ON account_holds (account_id) WHERE status = 'active';
CREATE INDEX account_holds_reference ON account_holds (reference);

-- +goose Down
DROP TABLE account_holds;
