-- +goose Up
-- Customer accounts (FR-ACC). The ledger (00009) knows balances; this is what the customer
-- sees around them: the account number, nickname and status of each account, and one
-- statement line per account per movement of money.

-- Holds carry what they are for and when they lapse, for the holds list (ACC-3).
ALTER TABLE account_holds
  ADD COLUMN reason text NOT NULL DEFAULT 'pending_transfer' CHECK (reason IN (
    'card_authorization', 'pending_transfer', 'delayed_transfer', 'fraud_review', 'ajo_contribution', 'dispute')),
  ADD COLUMN expires_at timestamptz;
ALTER TABLE account_holds ALTER COLUMN reason DROP DEFAULT;

-- NUBAN serials are nine digits; the tenth is the check digit (ACC-1). Starting at
-- 100000000 keeps every account number free of a leading zero.
CREATE SEQUENCE nuban_serial AS bigint START 100000000 MINVALUE 100000000 MAXVALUE 999999999;
-- Foreign wallets get a simulated ten-digit number of their own (ACC-2).
CREATE SEQUENCE wallet_number_serial AS bigint START 1 MINVALUE 1 MAXVALUE 99999999;

CREATE TABLE customer_accounts (
  account_id     uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES users (id),
  currency       text        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('ngn_current', 'fx_wallet')),
  account_number text        NOT NULL UNIQUE CHECK (account_number ~ '^[0-9]{10}$'),
  nickname       text        CHECK (length(nickname) BETWEEN 1 AND 40),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency),
  -- The naira account is the current account; every other currency is a wallet.
  CHECK ((kind = 'ngn_current') = (currency = 'NGN')),
  UNIQUE (user_id, currency)
);

-- One line per account per business movement, written in the same transaction as the
-- journal entry it describes (or, for a transfer still in flight, before there is one).
-- Amounts are positive; direction gives the sign, as in the contract's Transaction.
CREATE TABLE transactions (
  id                  uuid        PRIMARY KEY,
  user_id             uuid        NOT NULL REFERENCES users (id),
  account_id          uuid        NOT NULL,
  currency            text        NOT NULL,
  entry_id            uuid        REFERENCES journal_entries (id),
  type                text        NOT NULL CHECK (type IN (
                        'transfer_in', 'transfer_out', 'card_payment', 'card_refund', 'bill_payment', 'fx_conversion',
                        'savings', 'ajo', 'loan_disbursement', 'loan_repayment', 'interest', 'fee', 'levy', 'reversal',
                        'deposit', 'dispute_refund')),
  direction           text        NOT NULL CHECK (direction IN ('credit', 'debit')),
  status              text        NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  fee_minor           bigint      CHECK (fee_minor > 0),
  fee_code            text        CHECK (fee_code IN (
                        'transfer_fee', 'emtl', 'fx_spread', 'fx_fee', 'card_fee', 'bill_fee', 'early_break_penalty')),
  -- The account's ledger balance after the entry; null until the money has moved.
  balance_after_minor bigint,
  narration           text        NOT NULL CHECK (length(narration) <= 200),
  reference           text        NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  category            text        NOT NULL CHECK (category IN (
                        'food', 'groceries', 'transport', 'airtime_data', 'bills_utilities', 'shopping', 'entertainment',
                        'subscriptions', 'health', 'education', 'rent_housing', 'family', 'transfers', 'salary_income',
                        'savings', 'fees_charges', 'cash', 'other')),
  category_source     text        NOT NULL DEFAULT 'rules' CHECK (category_source IN ('rules', 'model', 'user')),
  category_confidence real        CHECK (category_confidence BETWEEN 0 AND 1),
  -- Name, @nemtag, bank, masked account number or merchant ID: what the app shows.
  counterparty        jsonb       NOT NULL CHECK (jsonb_typeof(counterparty) = 'object' AND counterparty ? 'name'),
  transfer_id         uuid,
  card_id             uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency),
  CHECK ((fee_minor IS NULL) = (fee_code IS NULL)),
  -- Money that moved always points at the entry that moved it.
  CHECK (status NOT IN ('completed', 'reversed') OR (entry_id IS NOT NULL AND balance_after_minor IS NOT NULL)),
  CHECK (category_source = 'model' OR category_confidence IS NULL)
);
-- The history list: newest first, per customer or per account, keyset paged.
CREATE INDEX transactions_user ON transactions (user_id, created_at DESC, id DESC);
CREATE INDEX transactions_account ON transactions (account_id, created_at DESC, id DESC);
CREATE INDEX transactions_entry ON transactions (entry_id) WHERE entry_id IS NOT NULL;
CREATE INDEX transactions_transfer ON transactions (transfer_id) WHERE transfer_id IS NOT NULL;

-- +goose Down
DROP TABLE transactions;
DROP TABLE customer_accounts;
DROP SEQUENCE wallet_number_serial;
DROP SEQUENCE nuban_serial;
ALTER TABLE account_holds DROP COLUMN expires_at, DROP COLUMN reason;
