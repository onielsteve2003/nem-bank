-- +goose Up
-- Saved billers and scheduled bill payments (BILL-3). A saved biller is a shortcut to a meter,
-- smartcard or phone number; a schedule pays a bill once or on a repeat from a naira account.
CREATE TABLE saved_billers (
  id            uuid        PRIMARY KEY,
  user_id       uuid        NOT NULL REFERENCES users (id),
  biller_id     text        NOT NULL,
  biller_name   text        NOT NULL,
  category      text        NOT NULL CHECK (category IN ('airtime', 'data', 'electricity', 'cable_tv')),
  customer_id   text        NOT NULL CHECK (length(customer_id) BETWEEN 1 AND 40),
  customer_name text,
  nickname      text        NOT NULL CHECK (length(nickname) BETWEEN 1 AND 30),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, biller_id, customer_id)
);

CREATE TABLE bill_schedules (
  id                uuid        PRIMARY KEY,
  user_id           uuid        NOT NULL REFERENCES users (id),
  source_account_id uuid        NOT NULL REFERENCES customer_accounts (account_id),
  biller_id         text        NOT NULL,
  biller_name       text        NOT NULL,
  product_id        text,
  customer_id       text        NOT NULL,
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  frequency         text        NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly', 'monthly')),
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  next_run_at       timestamptz,
  run_count         integer     NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  -- What the last run did: "completed", or the reason it was skipped.
  last_result       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR next_run_at IS NOT NULL),
  CHECK (status NOT IN ('cancelled', 'completed') OR next_run_at IS NULL)
);
CREATE INDEX bill_schedules_user ON bill_schedules (user_id, created_at DESC, id DESC);
CREATE INDEX bill_schedules_due ON bill_schedules (next_run_at) WHERE status = 'active';

-- +goose Down
DROP TABLE bill_schedules;
DROP TABLE saved_billers;
