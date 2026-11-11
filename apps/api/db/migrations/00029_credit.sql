-- +goose Up
-- Credit (FR-CRD, T28.5). A loan is a receivable ledger account (kind customer_loan): the
-- disbursement books principal + interest + fee on it as a debit, so what the customer owes
-- is always the negated ledger balance and every repayment is one posting. Loan accounts
-- are one per loan (a customer can borrow again after repaying), so the one-per-kind rule
-- is lifted for them as it already is for goals and locks.
DROP INDEX ledger_accounts_customer;
CREATE UNIQUE INDEX ledger_accounts_customer ON ledger_accounts (owner_id, kind, currency)
  WHERE owner_type = 'customer' AND kind NOT IN ('customer_savings', 'customer_locked', 'customer_loan');

-- A priced offer (CRD-2). It fixes the terms for ten minutes; accepting it turns it into a loan.
CREATE TABLE loan_offers (
  id               uuid        PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES users (id),
  principal_minor  bigint      NOT NULL CHECK (principal_minor > 0),
  tenor_days       integer     NOT NULL CHECK (tenor_days IN (30, 60, 90, 180)),
  apr_bps          integer     NOT NULL CHECK (apr_bps > 0),
  interest_minor   bigint      NOT NULL CHECK (interest_minor >= 0),
  fee_minor        bigint      NOT NULL CHECK (fee_minor >= 0),
  -- The first instalment falls 30 days after this Lagos day; fixed here so the schedule
  -- the customer saw is the schedule they get.
  start_date       date        NOT NULL,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL
);
CREATE INDEX loan_offers_user ON loan_offers (user_id, created_at DESC);

CREATE TABLE loans (
  id                    uuid        PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id),
  -- One loan per offer: accepting twice (a retry) finds the loan that already exists.
  offer_id              uuid        NOT NULL UNIQUE REFERENCES loan_offers (id),
  account_id            uuid        NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  -- Where the money went and where auto-repay collects from (the customer's naira account).
  repayment_account_id  uuid        NOT NULL REFERENCES ledger_accounts (id),
  principal_minor       bigint      NOT NULL CHECK (principal_minor > 0),
  apr_bps               integer     NOT NULL CHECK (apr_bps > 0),
  tenor_days            integer     NOT NULL CHECK (tenor_days IN (30, 60, 90, 180)),
  interest_minor        bigint      NOT NULL CHECK (interest_minor >= 0),
  fee_minor             bigint      NOT NULL CHECK (fee_minor >= 0),
  total_minor           bigint      NOT NULL CHECK (total_minor > 0),
  -- Unused interest given back when the loan was paid off early (CRD-4).
  rebate_minor          bigint      NOT NULL DEFAULT 0 CHECK (rebate_minor >= 0),
  start_date            date        NOT NULL,
  -- Overdue is not stored: it is "an instalment is past due", read at the time.
  status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'repaid', 'defaulted')),
  auto_repay            boolean     NOT NULL,
  disbursed_at          timestamptz NOT NULL,
  closed_at             timestamptz,
  -- Kept after a late repayment, so the scorer remembers the customer once defaulted.
  defaulted_at          timestamptz,
  CHECK (total_minor = principal_minor + interest_minor + fee_minor),
  CHECK ((status = 'repaid') = (closed_at IS NOT NULL))
);
CREATE INDEX loans_user ON loans (user_id, disbursed_at DESC, id DESC);
-- One loan at a time: the database refuses a second open loan, whatever races.
CREATE UNIQUE INDEX loans_one_open ON loans (user_id) WHERE status <> 'repaid';

CREATE TABLE loan_installments (
  loan_id              uuid        NOT NULL REFERENCES loans (id),
  number               integer     NOT NULL CHECK (number >= 1),
  due_date             date        NOT NULL,
  amount_minor         bigint      NOT NULL CHECK (amount_minor > 0),
  paid_minor           bigint      NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  -- Set when the customer was told this instalment is overdue, so they are told once.
  overdue_notified_at  timestamptz,
  PRIMARY KEY (loan_id, number),
  CHECK (paid_minor <= amount_minor)
);

-- +goose Down
DROP TABLE loan_installments;
DROP TABLE loans;
DROP TABLE loan_offers;
DROP INDEX ledger_accounts_customer;
CREATE UNIQUE INDEX ledger_accounts_customer ON ledger_accounts (owner_id, kind, currency)
  WHERE owner_type = 'customer' AND kind NOT IN ('customer_savings', 'customer_locked');
