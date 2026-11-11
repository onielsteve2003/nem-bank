-- +goose Up
-- Digital Ajo (FR-AJO, T28.4). Members save into an escrow ledger account (kind
-- ajo_escrow) each cycle and one member takes the whole pot in turn. Escrow is a
-- dedicated ledger account per group, so the pot balance is always exactly what was
-- paid in and only the ledger can pay it out.
DROP INDEX ledger_accounts_system;
CREATE UNIQUE INDEX ledger_accounts_system ON ledger_accounts (kind, currency)
  WHERE owner_type = 'system' AND kind <> 'ajo_escrow';

CREATE TABLE ajo_groups (
  id                   uuid        PRIMARY KEY,
  name                 text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  account_id           uuid        NOT NULL UNIQUE REFERENCES ledger_accounts (id),
  created_by_id        uuid        NOT NULL REFERENCES users (id),
  contribution_minor   bigint      NOT NULL CHECK (contribution_minor > 0),
  frequency            text        NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  member_count         integer     NOT NULL CHECK (member_count BETWEEN 2 AND 30),
  rotation             text        NOT NULL CHECK (rotation IN ('fixed', 'random_draw')),
  start_date           date        NOT NULL,
  grace_period_hours   integer     NOT NULL DEFAULT 24 CHECK (grace_period_hours BETWEEN 0 AND 72),
  status               text        NOT NULL DEFAULT 'forming' CHECK (status IN ('forming', 'active', 'completed', 'cancelled')),
  current_cycle        integer     NOT NULL DEFAULT 0 CHECK (current_cycle >= 0),
  total_cycles         integer     NOT NULL CHECK (total_cycles >= 2),
  invite_code          text        NOT NULL UNIQUE,
  invite_expires_at    timestamptz NOT NULL,
  created_at           timestamptz NOT NULL,
  started_at           timestamptz,
  ended_at             timestamptz
);
CREATE INDEX ajo_groups_created_by ON ajo_groups (created_by_id, created_at DESC);
CREATE INDEX ajo_groups_active ON ajo_groups (status) WHERE status = 'active';

CREATE TABLE ajo_members (
  group_id             uuid        NOT NULL REFERENCES ajo_groups (id) ON DELETE CASCADE,
  user_id              uuid        NOT NULL REFERENCES users (id),
  source_account_id    uuid        NOT NULL REFERENCES customer_accounts (account_id),
  position             integer     CHECK (position > 0),
  status               text        NOT NULL DEFAULT 'joined' CHECK (status IN ('invited', 'joined', 'defaulted', 'left')),
  has_received_payout  boolean     NOT NULL DEFAULT false,
  contributions_paid   integer     NOT NULL DEFAULT 0 CHECK (contributions_paid >= 0),
  missed_contributions integer     NOT NULL DEFAULT 0 CHECK (missed_contributions >= 0),
  joined_at            timestamptz NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX ajo_members_user ON ajo_members (user_id, status);

CREATE TABLE ajo_cycles (
  id                   uuid        PRIMARY KEY,
  group_id             uuid        NOT NULL REFERENCES ajo_groups (id) ON DELETE CASCADE,
  cycle_number         integer     NOT NULL CHECK (cycle_number >= 1),
  due_at               timestamptz NOT NULL,
  payout_to_user_id    uuid        NOT NULL REFERENCES users (id),
  payout_amount_minor  bigint      NOT NULL CHECK (payout_amount_minor > 0),
  payout_status        text        NOT NULL DEFAULT 'upcoming' CHECK (payout_status IN ('upcoming', 'collecting', 'paid', 'short_paid')),
  created_at           timestamptz NOT NULL,
  UNIQUE (group_id, cycle_number)
);
CREATE INDEX ajo_cycles_group ON ajo_cycles (group_id, cycle_number);
CREATE INDEX ajo_cycles_due ON ajo_cycles (due_at) WHERE payout_status IN ('upcoming', 'collecting');

CREATE TABLE ajo_contributions (
  cycle_id             uuid        NOT NULL REFERENCES ajo_cycles (id) ON DELETE CASCADE,
  user_id              uuid        NOT NULL REFERENCES users (id),
  status               text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'late', 'defaulted')),
  attempts             integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  paid_at              timestamptz,
  entry_id             uuid        REFERENCES journal_entries (id),
  PRIMARY KEY (cycle_id, user_id)
);
CREATE INDEX ajo_contributions_cycle ON ajo_contributions (cycle_id);

-- +goose Down
DROP TABLE ajo_contributions;
DROP TABLE ajo_cycles;
DROP TABLE ajo_members;
DROP TABLE ajo_groups;
DROP INDEX ledger_accounts_system;
CREATE UNIQUE INDEX ledger_accounts_system ON ledger_accounts (kind, currency) WHERE owner_type = 'system';
