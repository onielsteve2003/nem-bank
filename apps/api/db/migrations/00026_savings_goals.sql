-- +goose Up
-- Savings goals, auto-save and round-ups (FR-SAV, T28.2). A goal's money sits in its own
-- ledger account (kind customer_savings), so the balance is the ledger's, never a column
-- here: the goal row holds only the settings around it.
CREATE TABLE savings_goals (
  id                     uuid        PRIMARY KEY,
  user_id                uuid        NOT NULL REFERENCES users (id),
  account_id             uuid        NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  name                   text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  emoji                  text        NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 8),
  target_minor           bigint      NOT NULL CHECK (target_minor > 0),
  target_date            date,
  -- Auto-save (SAV-2): all four are set together or none is.
  auto_save_amount_minor bigint      CHECK (auto_save_amount_minor > 0),
  auto_save_frequency    text        CHECK (auto_save_frequency IN ('daily', 'weekly', 'monthly')),
  auto_save_source_id    uuid        REFERENCES customer_accounts (account_id),
  auto_save_next_at      timestamptz,
  -- Daily interest (SAV-5, T28.3): the rate this goal earns, what it has earned, and the
  -- last Lagos day interest was paid for.
  interest_rate_bps      integer     NOT NULL DEFAULT 1000 CHECK (interest_rate_bps >= 0),
  interest_earned_minor  bigint      NOT NULL DEFAULT 0 CHECK (interest_earned_minor >= 0),
  interest_paid_to       date        NOT NULL,
  -- "completed" is not stored: it is an active goal whose balance reached its target.
  status                 text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at             timestamptz NOT NULL,
  closed_at              timestamptz,
  CHECK ((auto_save_amount_minor IS NULL) = (auto_save_frequency IS NULL)
     AND (auto_save_amount_minor IS NULL) = (auto_save_source_id IS NULL)
     AND (auto_save_amount_minor IS NULL) = (auto_save_next_at IS NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX savings_goals_user ON savings_goals (user_id, created_at DESC, id DESC);
-- The auto-save sweep looks only at active goals with a rule.
CREATE INDEX savings_goals_auto_save ON savings_goals (auto_save_next_at)
  WHERE status = 'active' AND auto_save_next_at IS NOT NULL;
CREATE INDEX savings_goals_interest ON savings_goals (interest_paid_to) WHERE status = 'active';

-- One round-up rule per customer (SAV-3).
CREATE TABLE round_up_settings (
  user_id        uuid        PRIMARY KEY REFERENCES users (id),
  enabled        boolean     NOT NULL,
  round_to_minor bigint      NOT NULL CHECK (round_to_minor IN (10000, 50000, 100000)),
  goal_id        uuid        REFERENCES savings_goals (id),
  sources        text[]      NOT NULL CHECK (sources <@ ARRAY['card', 'transfer']),
  -- Round-ups only apply to spending after this moment, so switching them on never
  -- backdates, even when an older event reaches the subscriber late.
  enabled_since  timestamptz,
  updated_at     timestamptz NOT NULL,
  CHECK (NOT enabled OR (goal_id IS NOT NULL AND enabled_since IS NOT NULL))
);

-- Every round-up taken. source_ref is the spend it came from ("card:<authorization>",
-- "transfer:<id>"): unique, so a replayed event can never round up the same spend twice.
CREATE TABLE round_ups (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id),
  goal_id      uuid        NOT NULL REFERENCES savings_goals (id),
  source_ref   text        NOT NULL UNIQUE,
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  entry_id     uuid        NOT NULL REFERENCES journal_entries (id),
  created_at   timestamptz NOT NULL
);
CREATE INDEX round_ups_user ON round_ups (user_id, created_at DESC);

-- +goose Down
DROP TABLE round_ups;
DROP TABLE round_up_settings;
DROP TABLE savings_goals;
