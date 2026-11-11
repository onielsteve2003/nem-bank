-- +goose Up
-- Virtual cards on Nem's own simulated processor (FR-CARD, CARD-1, CARD-7). A card spends
-- from one customer account. Its number never sits in the table in the clear: pan_enc is
-- AES-GCM ciphertext bound to the card's ID, and pan_index is a keyed blind index so the
-- processor can find a card from the number a merchant sends without decrypting anything.
-- The CVV is not stored at all: it is derived from the number and expiry with a server key,
-- the way a real processor's HSM does, so a copy of this table holds nothing a thief can
-- charge with.
CREATE TABLE cards (
  id                    uuid        PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id),
  account_id            uuid        NOT NULL,
  currency              text        NOT NULL CHECK (currency IN ('NGN', 'USD')),
  type                  text        NOT NULL CHECK (type IN ('standard', 'single_use', 'merchant_locked')),
  -- 'used' is a single-use card that has taken its one charge.
  status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'terminated', 'used')),
  network               text        NOT NULL CHECK (network IN ('nem_verve', 'nem_visa')),
  last4                 text        NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  pan_enc               bytea       NOT NULL,
  pan_index             bytea       NOT NULL UNIQUE,
  expiry_month          integer     NOT NULL CHECK (expiry_month BETWEEN 1 AND 12),
  expiry_year           integer     NOT NULL CHECK (expiry_year >= 2026),
  name_on_card          text        NOT NULL CHECK (length(name_on_card) BETWEEN 1 AND 100),
  nickname              text        CHECK (length(nickname) BETWEEN 1 AND 30),
  design                text        NOT NULL CHECK (design IN ('volt', 'noir', 'mint', 'coral')),
  spend_limit_minor     bigint      CHECK (spend_limit_minor > 0),
  spend_limit_period    text        CHECK (spend_limit_period IN ('per_transaction', 'daily', 'monthly')),
  online_enabled        boolean     NOT NULL DEFAULT true,
  international_enabled boolean     NOT NULL,
  merchant_id           text        CHECK (length(merchant_id) BETWEEN 1 AND 100),
  merchant_name         text        CHECK (length(merchant_name) BETWEEN 1 AND 100),
  frozen_by_panic       boolean     NOT NULL DEFAULT false,
  physical              boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL,
  terminated_at         timestamptz,
  -- The card's currency is its account's: a dollar card can never sit on a naira account.
  FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency),
  CHECK ((spend_limit_minor IS NULL) = (spend_limit_period IS NULL)),
  CHECK ((merchant_id IS NULL) = (merchant_name IS NULL)),
  CHECK ((status = 'terminated') = (terminated_at IS NOT NULL)),
  CHECK (NOT frozen_by_panic OR status IN ('frozen', 'terminated'))
);
CREATE INDEX cards_user ON cards (user_id, created_at DESC, id DESC);

-- +goose Down
DROP TABLE cards;
