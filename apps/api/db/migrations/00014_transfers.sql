-- +goose Up
-- Transfers (FR-TRF). A transfer is a state machine (contract TransferStatus):
--
--   created → risk_checked → processing → completed | failed → reversed
--   risk_checked → pending_step_up | delayed | held_for_review | completed (internal)
--   plus rejected and cancelled.
--
-- The service moves it through these states, and the trigger below refuses any other
-- move, so a bug can never take a completed transfer back to processing.

CREATE TABLE transfers (
  id                     uuid        PRIMARY KEY,
  user_id                uuid        NOT NULL REFERENCES users (id),
  -- What the customer quotes to support and what both statements show.
  reference              text        NOT NULL UNIQUE CHECK (reference ~ '^NEM[0-9]{8}[A-Z0-9]{6}$'),
  status                 text        NOT NULL DEFAULT 'created' CHECK (status IN (
                           'created', 'risk_checked', 'pending_step_up', 'delayed', 'held_for_review', 'processing',
                           'completed', 'failed', 'reversed', 'rejected', 'cancelled')),
  rail                   text        NOT NULL CHECK (rail IN ('internal', 'interbank')),
  source_account_id      uuid        NOT NULL REFERENCES customer_accounts (account_id),
  -- The receiving Nem account on the internal rail.
  destination_account_id uuid        REFERENCES customer_accounts (account_id),
  -- Name, @nemtag, bank and masked number as the contract's TransferParty.
  recipient              jsonb       NOT NULL CHECK (jsonb_typeof(recipient) = 'object' AND recipient ? 'name'),
  currency               text        NOT NULL CHECK (currency IN ('NGN', 'USD', 'GBP', 'EUR')),
  amount_minor           bigint      NOT NULL CHECK (amount_minor > 0),
  fee_minor              bigint      NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  narration              text        NOT NULL CHECK (length(narration) BETWEEN 1 AND 100),
  category               text,
  risk                   jsonb,
  step_up_id             uuid,
  release_at             timestamptz,
  hold_id                uuid        REFERENCES account_holds (id),
  -- The sender's transaction line and, once money moved, the journal entry.
  transaction_id         uuid        NOT NULL REFERENCES transactions (id) DEFERRABLE INITIALLY DEFERRED,
  entry_id               uuid        REFERENCES journal_entries (id),
  reversal               jsonb,
  -- Accepted while the customer was in duress (SEC-5): it looks sent but moves nothing.
  duress_blocked         boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((rail = 'internal') = (destination_account_id IS NOT NULL)),
  CHECK (destination_account_id IS DISTINCT FROM source_account_id),
  -- A completed transfer always points at the entry that moved the money.
  CHECK (status <> 'completed' OR entry_id IS NOT NULL)
);
CREATE INDEX transfers_user ON transfers (user_id, created_at DESC, id DESC);
CREATE INDEX transfers_user_status ON transfers (user_id, status, created_at DESC, id DESC);

-- The timeline (TRF-7): one row per step, append-only, in order.
CREATE TABLE transfer_events (
  transfer_id uuid        NOT NULL REFERENCES transfers (id),
  seq         integer     NOT NULL CHECK (seq >= 1),
  status      text        NOT NULL,
  label       text        NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  detail      text,
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (transfer_id, seq)
);
CREATE TRIGGER transfer_events_no_change BEFORE UPDATE OR DELETE ON transfer_events
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- +goose StatementBegin
CREATE FUNCTION transfers_check_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status || '>' || NEW.status) <> ALL (ARRAY[
    'created>risk_checked', 'created>rejected',
    'risk_checked>pending_step_up', 'risk_checked>delayed', 'risk_checked>held_for_review',
    'risk_checked>processing', 'risk_checked>completed', 'risk_checked>rejected',
    'pending_step_up>processing', 'pending_step_up>completed', 'pending_step_up>cancelled', 'pending_step_up>rejected',
    'delayed>processing', 'delayed>completed', 'delayed>cancelled',
    'held_for_review>processing', 'held_for_review>completed', 'held_for_review>rejected', 'held_for_review>cancelled',
    'processing>completed', 'processing>failed',
    'failed>reversed'
  ]) THEN
    RAISE EXCEPTION 'transfer % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd
CREATE TRIGGER transfers_transition BEFORE UPDATE OF status ON transfers
  FOR EACH ROW EXECUTE FUNCTION transfers_check_transition();

-- Transaction lines point back at their transfer.
ALTER TABLE transactions ADD FOREIGN KEY (transfer_id) REFERENCES transfers (id) DEFERRABLE INITIALLY DEFERRED;

-- +goose Down
ALTER TABLE transactions DROP CONSTRAINT transactions_transfer_id_fkey;
DROP TABLE transfer_events;
DROP TABLE transfers;
DROP FUNCTION transfers_check_transition();
