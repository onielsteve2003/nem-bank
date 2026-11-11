-- +goose Up
-- Bill payments (FR-BILL, T28.1): airtime, data, electricity and cable TV bought through a
-- Biller. The customer is debited first, then the biller is asked to deliver; if it
-- refuses, the debit is reversed (BILL-4).
CREATE TABLE bill_payments (
  id             uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id),
  account_id     uuid        NOT NULL REFERENCES customer_accounts (account_id),
  reference      text        NOT NULL UNIQUE,
  biller_id      text        NOT NULL,
  biller_name    text        NOT NULL,
  category       text        NOT NULL CHECK (category IN ('airtime', 'data', 'electricity', 'cable_tv')),
  product_id     text,
  product_name   text,
  -- The phone, meter or smartcard number. Not a secret, but never logged.
  customer_id    text        NOT NULL,
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  fee_minor      bigint      NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  status         text        NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed', 'reversed')),
  -- What the biller handed back: a prepaid token and its units.
  token          text,
  units          text,
  -- The daily-limit day this payment was counted on, so a reversal can give it back.
  limit_day      date        NOT NULL,
  entry_id       uuid        REFERENCES journal_entries (id),
  reversal_entry_id uuid     REFERENCES journal_entries (id),
  transaction_id uuid        REFERENCES transactions (id),
  failure_reason text,
  created_at     timestamptz NOT NULL,
  completed_at   timestamptz,
  CHECK ((token IS NULL) OR status = 'completed')
);
CREATE INDEX bill_payments_user ON bill_payments (user_id, created_at DESC, id DESC);
-- Sweeping up payments that were debited but never finished (a crash between the two steps).
CREATE INDEX bill_payments_open ON bill_payments (created_at) WHERE status = 'processing';

-- +goose Down
DROP TABLE bill_payments;
