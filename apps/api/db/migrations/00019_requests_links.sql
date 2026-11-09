-- +goose Up
-- Money requests, split bills and payment links (T25.7). Paying any of them is a normal
-- transfer (limits, fees, cooling-off), written in the same transaction that marks the
-- request paid or counts the link's takings.

CREATE TABLE split_bills (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users (id),
  title       text        NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  currency    text        NOT NULL CHECK (currency = 'NGN'),
  total_minor bigint      NOT NULL CHECK (total_minor > 0),
  split       text        NOT NULL CHECK (split IN ('equal', 'custom')),
  -- The creator's own part when they count themselves in; null when they do not.
  self_minor  bigint      CHECK (self_minor >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX split_bills_user ON split_bills (user_id, created_at DESC, id DESC);

-- TRF-10. A request is pending until the payer pays or declines it, the requester cancels
-- it, or it expires (expires_at passes while pending).
CREATE TABLE money_requests (
  id               uuid        PRIMARY KEY,
  requester_id     uuid        NOT NULL REFERENCES users (id),
  payer_id         uuid        NOT NULL REFERENCES users (id),
  currency         text        NOT NULL CHECK (currency = 'NGN'),
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  note             text        NOT NULL DEFAULT '' CHECK (length(note) <= 100),
  status           text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'declined', 'cancelled', 'expired')),
  split_bill_id    uuid        REFERENCES split_bills (id),
  transfer_id      uuid        REFERENCES transfers (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  responded_at     timestamptz,
  last_reminded_at timestamptz,
  CHECK (requester_id <> payer_id),
  CHECK ((status = 'paid') = (transfer_id IS NOT NULL)),
  CHECK ((status = 'pending') = (responded_at IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX money_requests_requester ON money_requests (requester_id, created_at DESC, id DESC);
CREATE INDEX money_requests_payer ON money_requests (payer_id, created_at DESC, id DESC);
CREATE INDEX money_requests_split ON money_requests (split_bill_id) WHERE split_bill_id IS NOT NULL;

-- TRF-12. A link pays into one of the owner's naira accounts; `expired` is worked out from
-- expires_at, never stored.
CREATE TABLE payment_links (
  id                   uuid        PRIMARY KEY,
  user_id              uuid        NOT NULL REFERENCES users (id),
  account_id           uuid        NOT NULL REFERENCES customer_accounts (account_id),
  slug                 text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z2-9]{8}$'),
  title                text        NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  note                 text        CHECK (length(note) BETWEEN 1 AND 200),
  amount_mode          text        NOT NULL CHECK (amount_mode IN ('fixed', 'open')),
  currency             text        NOT NULL CHECK (currency = 'NGN'),
  amount_minor         bigint      CHECK (amount_minor > 0),
  status               text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  expires_at           timestamptz,
  payments_count       integer     NOT NULL DEFAULT 0 CHECK (payments_count >= 0),
  total_received_minor bigint      NOT NULL DEFAULT 0 CHECK (total_received_minor >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((amount_mode = 'fixed') = (amount_minor IS NOT NULL))
);
CREATE INDEX payment_links_user ON payment_links (user_id, created_at DESC, id DESC);

-- What a transfer paid, for the receipt and for support.
ALTER TABLE transfers
  ADD COLUMN money_request_id uuid REFERENCES money_requests (id),
  ADD COLUMN payment_link_id  uuid REFERENCES payment_links (id);

-- +goose Down
ALTER TABLE transfers DROP COLUMN payment_link_id, DROP COLUMN money_request_id;
DROP TABLE payment_links;
DROP TABLE money_requests;
DROP TABLE split_bills;
