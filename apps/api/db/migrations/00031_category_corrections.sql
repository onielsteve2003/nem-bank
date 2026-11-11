-- +goose Up
-- Smart categories (AI-3). A customer's correction beats every guess, is remembered for
-- the merchant when they ask for that, and is kept as a labelled example for retraining.
CREATE TABLE merchant_category_rules (
  user_id      uuid        NOT NULL REFERENCES users (id),
  -- Lowercase, single-spaced merchant name (categorize.MerchantKey).
  merchant_key text        NOT NULL CHECK (length(merchant_key) BETWEEN 1 AND 200),
  category     text        NOT NULL CHECK (category IN (
                 'food', 'groceries', 'transport', 'airtime_data', 'bills_utilities', 'shopping', 'entertainment',
                 'subscriptions', 'health', 'education', 'rent_housing', 'family', 'transfers', 'salary_income',
                 'savings', 'fees_charges', 'cash', 'other')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, merchant_key)
);

CREATE TABLE category_corrections (
  id                  uuid        PRIMARY KEY,
  user_id             uuid        NOT NULL REFERENCES users (id),
  transaction_id      uuid        NOT NULL REFERENCES transactions (id),
  merchant_key        text        NOT NULL,
  -- What the classifier read: the counterparty name and the narration.
  text                text        NOT NULL,
  previous_category   text        NOT NULL,
  previous_source     text        NOT NULL CHECK (previous_source IN ('rules', 'model', 'user')),
  previous_confidence real,
  category            text        NOT NULL,
  apply_to_similar    boolean     NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX category_corrections_created ON category_corrections (created_at);
CREATE INDEX category_corrections_user ON category_corrections (user_id, created_at);

-- +goose Down
DROP TABLE category_corrections;
DROP TABLE merchant_category_rules;
