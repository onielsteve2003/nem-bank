-- +goose Up
-- FX quotes and conversions (FR-FX, FX-1 and FX-4). Rates are whole numbers of 1e-8, as in 00020.

-- A rate locked for 60 seconds (FX-1). The amounts are fixed when the quote is made, so
-- converting posts exactly what the customer was shown.
CREATE TABLE fx_quotes (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id),
  from_account_id uuid        NOT NULL REFERENCES customer_accounts (account_id),
  to_account_id   uuid        NOT NULL REFERENCES customer_accounts (account_id),
  sell_currency   text        NOT NULL,
  sell_minor      bigint      NOT NULL CHECK (sell_minor > 0),
  buy_currency    text        NOT NULL,
  buy_minor       bigint      NOT NULL CHECK (buy_minor > 0),
  -- Units of the bought currency per unit sold, and the mid rate it came from, both x1e8.
  rate_e8         bigint      NOT NULL CHECK (rate_e8 > 0),
  mid_e8          bigint      NOT NULL CHECK (mid_e8 > 0),
  spread_bps      integer     NOT NULL CHECK (spread_bps BETWEEN 0 AND 9999),
  fee_minor       bigint      NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  CHECK (sell_currency <> buy_currency),
  CHECK (expires_at > created_at)
);
CREATE INDEX fx_quotes_expiry ON fx_quotes (expires_at);

-- One conversion per quote: the unique key is what makes a quote single-use, even if two
-- requests race for it.
CREATE TABLE fx_conversions (
  id                    uuid        PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id),
  quote_id              uuid        NOT NULL UNIQUE REFERENCES fx_quotes (id),
  entry_id              uuid        NOT NULL REFERENCES journal_entries (id),
  debit_transaction_id  uuid        NOT NULL REFERENCES transactions (id),
  credit_transaction_id uuid        NOT NULL REFERENCES transactions (id),
  status                text        NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  created_at            timestamptz NOT NULL
);
CREATE INDEX fx_conversions_user ON fx_conversions (user_id, created_at DESC, id DESC);

-- +goose Down
DROP TABLE fx_conversions;
DROP TABLE fx_quotes;
