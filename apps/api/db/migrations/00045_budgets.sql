-- +goose Up
-- Monthly budgets per spending category (INS-2). Naira only, one per category per customer. What
-- has been spent is never stored: it is read from the customer's transaction history each time.
CREATE TABLE budgets (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id),
  category    text        NOT NULL CHECK (category IN (
                'food', 'groceries', 'transport', 'airtime_data', 'bills_utilities', 'shopping', 'entertainment',
                'subscriptions', 'health', 'education', 'rent_housing', 'family', 'transfers', 'salary_income',
                'savings', 'fees_charges', 'cash', 'other')),
  limit_minor bigint      NOT NULL CHECK (limit_minor > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, category)
);

-- +goose Down
DROP TABLE budgets;
