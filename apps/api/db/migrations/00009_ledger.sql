-- +goose Up
-- The double-entry ledger (ADR-4, PRD NFR money correctness). Every movement of money is a
-- journal entry of two or more postings that sum to zero in each currency. Amounts are
-- signed integer minor units: credits positive, debits negative (the contract's Posting).
-- The rules below hold in the database itself, so a bug in the posting engine (T24.3)
-- fails the transaction instead of corrupting balances.

CREATE TABLE ledger_accounts (
  id              uuid        PRIMARY KEY,
  owner_type      text        NOT NULL CHECK (owner_type IN ('customer', 'system')),
  -- The customer for customer accounts; NULL for the bank's own (system) accounts.
  owner_id        uuid        REFERENCES users (id),
  kind            text        NOT NULL CHECK (kind IN (
                    'customer_current', 'customer_wallet', 'customer_savings', 'customer_locked', 'customer_loan',
                    'fee_income', 'fx_position', 'interest_expense', 'interest_income', 'ajo_escrow',
                    'card_settlement', 'partner_settlement', 'levy_payable', 'demo_funding', 'suspense')),
  currency        text        NOT NULL CHECK (currency IN ('NGN', 'USD', 'GBP', 'EUR')),
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- Cached from the postings by the posting engine, under a row lock. The ledger balance
  -- counts every posting; available also subtracts active holds (ACC-3).
  balance_minor   bigint      NOT NULL DEFAULT 0,
  available_minor bigint      NOT NULL DEFAULT 0,
  -- Bumped on every posting, so a reader can tell a balance it cached has moved.
  version         bigint      NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Customer accounts belong to a customer; system accounts to nobody.
  CHECK ((owner_type = 'customer') = (owner_id IS NOT NULL)),
  CHECK ((owner_type = 'customer') = (kind LIKE 'customer\_%')),
  -- Holds only ever reduce what can be spent.
  CHECK (available_minor <= balance_minor),
  -- No customer deposit goes below zero, by either measure (NFR money correctness). A loan
  -- is the bank's asset, so its balance is a debit (negative) and is not covered here.
  CHECK (kind NOT IN ('customer_current', 'customer_wallet', 'customer_savings', 'customer_locked')
         OR available_minor >= 0),
  -- The target of the postings foreign key, which keeps a posting in its account's currency.
  UNIQUE (id, currency)
);
-- One bank account per kind and currency (fee income in NGN, the USD FX position, ...).
CREATE UNIQUE INDEX ledger_accounts_system ON ledger_accounts (kind, currency) WHERE owner_type = 'system';
-- One account of each kind per currency per customer (one NGN current, one USD wallet, ...).
-- Savings goals can have several, so they are left out.
CREATE UNIQUE INDEX ledger_accounts_customer ON ledger_accounts (owner_id, kind, currency)
  WHERE owner_type = 'customer' AND kind <> 'customer_savings';
CREATE INDEX ledger_accounts_owner ON ledger_accounts (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE journal_entries (
  id              uuid        PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN (
                    'transfer_internal', 'transfer_external', 'transfer_reversal', 'fee', 'levy', 'fx_conversion',
                    'card_authorization', 'card_settlement', 'card_reversal', 'bill_payment', 'savings',
                    'interest_accrual', 'ajo_contribution', 'ajo_payout', 'loan_disbursement', 'loan_repayment',
                    'dispute_refund', 'demo_funding', 'manual_adjustment')),
  -- What the entry is for: a transfer ID, a card authorisation, a bill reference.
  reference       text        NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  -- The business operation's key. Unique, so the same operation can never post twice,
  -- even if the idempotency middleware (T24.4) were bypassed.
  idempotency_key text        UNIQUE,
  -- A manual adjustment only ever posts after a second staff member approved it (ADM-10).
  approval_id     uuid        REFERENCES approval_requests (id),
  -- IDs and codes, never PII.
  metadata        jsonb       NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- The (top-level) transaction that wrote the entry. Postings must come from the same
  -- one; xmin would not do, because a savepoint gives the row a subtransaction's ID.
  xact_id         xid8        NOT NULL DEFAULT pg_current_xact_id(),
  CHECK (kind <> 'manual_adjustment' OR approval_id IS NOT NULL)
);
CREATE INDEX journal_entries_created ON journal_entries (created_at DESC, id DESC);
CREATE INDEX journal_entries_reference ON journal_entries (reference);

CREATE TABLE postings (
  id                  uuid        PRIMARY KEY,
  entry_id            uuid        NOT NULL REFERENCES journal_entries (id),
  account_id          uuid        NOT NULL,
  amount_minor        bigint      NOT NULL CHECK (amount_minor <> 0),
  -- Copied from the account, and the foreign key below makes the two agree: a posting in
  -- dollars can never land on a naira account.
  currency            text        NOT NULL,
  -- The account's ledger balance just after this posting, for statements and the explorer.
  balance_after_minor bigint      NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency)
);
CREATE INDEX postings_entry ON postings (entry_id);
CREATE INDEX postings_account ON postings (account_id, created_at DESC, id DESC);

-- +goose StatementBegin
-- Runs at COMMIT (deferred), once every posting of the entry is in: each currency must
-- net to zero, and an entry needs at least two postings. Postings can only be added in
-- the transaction that created their entry, so a committed entry can never be reopened.
CREATE FUNCTION ledger_check_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry uuid;
  bad   record;
  n     integer;
BEGIN
  IF TG_TABLE_NAME = 'postings' THEN
    entry := NEW.entry_id;
    IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = entry AND xact_id = pg_current_xact_id()) THEN
      RAISE EXCEPTION 'journal entry % is closed: postings are added only with the entry', entry
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    entry := NEW.id;
  END IF;
  SELECT count(*) INTO n FROM postings WHERE entry_id = entry;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % has % posting(s); it needs at least 2', entry, n
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT currency, sum(amount_minor) AS net INTO bad
  FROM postings WHERE entry_id = entry
  GROUP BY currency HAVING sum(amount_minor) <> 0
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: % nets to %', entry, bad.currency, bad.net
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
-- +goose StatementEnd
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();
-- Also on the entry, so one with no postings at all cannot commit either.
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();

-- +goose StatementBegin
-- History is never edited: a mistake is corrected by a new, reversing entry.
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: post a reversing entry instead', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;
-- +goose StatementEnd
CREATE TRIGGER journal_entries_no_change BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER postings_no_change BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON postings
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

-- The bank's own accounts. IDs are fixed (…5a00000 + kind + currency), so fixtures, docs
-- and the console can name them. FX positions exist in every currency, so a conversion
-- balances within each currency on its own (architecture §4).
INSERT INTO ledger_accounts (id, owner_type, kind, currency, name)
SELECT ('01900000-0000-7000-8000-5a000000' || lpad(k.n::text, 2, '0') || lpad(c.n::text, 2, '0'))::uuid,
       'system', k.kind, c.code, k.name || ' (' || c.code || ')'
FROM (VALUES
       (1, 'suspense', 'Suspense', ARRAY['NGN', 'USD', 'GBP', 'EUR']),
       (2, 'fee_income', 'Fee income', ARRAY['NGN', 'USD', 'GBP', 'EUR']),
       (3, 'fx_position', 'FX position', ARRAY['NGN', 'USD', 'GBP', 'EUR']),
       (4, 'partner_settlement', 'Partner settlement', ARRAY['NGN', 'USD', 'GBP', 'EUR']),
       (5, 'card_settlement', 'Card settlement', ARRAY['NGN', 'USD']),
       (6, 'interest_expense', 'Interest expense', ARRAY['NGN']),
       (7, 'interest_income', 'Interest income', ARRAY['NGN']),
       (8, 'levy_payable', 'EMTL levy payable', ARRAY['NGN']),
       (9, 'ajo_escrow', 'Ajo escrow', ARRAY['NGN']),
       (10, 'demo_funding', 'Demo funding', ARRAY['NGN', 'USD', 'GBP', 'EUR'])
     ) AS k (n, kind, name, currencies)
CROSS JOIN LATERAL unnest(k.currencies) WITH ORDINALITY AS c (code, n);

-- +goose Down
DROP TABLE postings;
DROP TABLE journal_entries;
DROP TABLE ledger_accounts;
DROP FUNCTION ledger_append_only();
DROP FUNCTION ledger_check_entry();
