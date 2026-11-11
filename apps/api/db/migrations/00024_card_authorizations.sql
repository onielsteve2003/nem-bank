-- +goose Up
-- Card authorizations (CARD-5, CARD-7). A merchant asks the processor whether a card may be
-- charged. Approved, the processor holds the money on the customer's account and records an
-- authorization; declined, it records why, so the customer can see the attempt and the
-- reason. The hold is the ledger's account_holds row; settling it into a posting, or
-- letting it lapse, is the clearing step.
CREATE TABLE card_authorizations (
  id               uuid        PRIMARY KEY,
  card_id          uuid        NOT NULL REFERENCES cards (id),
  user_id          uuid        NOT NULL REFERENCES users (id),
  account_id       uuid        NOT NULL,
  -- Set for every approved authorization, null for a decline (nothing was set aside).
  hold_id          uuid        REFERENCES account_holds (id),
  merchant_id      text        NOT NULL CHECK (length(merchant_id) BETWEEN 1 AND 100),
  merchant_name    text        NOT NULL CHECK (length(merchant_name) BETWEEN 1 AND 100),
  mcc              text        NOT NULL CHECK (mcc ~ '^[0-9]{4}$'),
  country          text        NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  channel          text        NOT NULL CHECK (channel IN ('online', 'in_store')),
  -- What the merchant asked for, in the merchant's currency, and what the card's account
  -- pays, in the card's currency. They are equal unless the currencies differ.
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  amount_currency  text        NOT NULL CHECK (amount_currency IN ('NGN', 'USD', 'GBP', 'EUR')),
  billing_minor    bigint      NOT NULL CHECK (billing_minor > 0),
  billing_currency text        NOT NULL CHECK (billing_currency IN ('NGN', 'USD')),
  status           text        NOT NULL CHECK (status IN ('authorized', 'settled', 'reversed', 'declined')),
  decline_reason   text        CHECK (decline_reason IN (
                     'insufficient_funds', 'card_frozen', 'limit_exceeded', 'online_disabled',
                     'international_disabled', 'merchant_not_allowed', 'card_used')),
  transaction_id   uuid,
  authorized_at    timestamptz NOT NULL,
  -- When the hold lapses by itself if the merchant never settles.
  expires_at       timestamptz,
  settled_at       timestamptz,
  FOREIGN KEY (account_id, billing_currency) REFERENCES ledger_accounts (id, currency),
  CHECK ((status = 'declined') = (decline_reason IS NOT NULL)),
  CHECK ((status = 'declined') = (hold_id IS NULL)),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL))
);
-- A card's own list, newest first.
CREATE INDEX card_authorizations_card ON card_authorizations (card_id, authorized_at DESC, id DESC);
-- Spend-limit sums and the single-use check read only what counts against the card.
CREATE INDEX card_authorizations_spend ON card_authorizations (card_id, authorized_at)
  WHERE status IN ('authorized', 'settled');
-- The hold-expiry sweep reads only what is still waiting.
CREATE INDEX card_authorizations_open ON card_authorizations (expires_at) WHERE status = 'authorized';

-- +goose Down
DROP TABLE card_authorizations;
