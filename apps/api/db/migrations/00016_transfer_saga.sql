-- +goose Up
-- The external transfer saga (T25.4). Money for another bank is held, sent through the
-- partner, then settled by the partner's answer (callback or status query) or released if
-- the partner fails it or never answers before the deadline.

ALTER TABLE transfers
  -- Where an interbank transfer goes, in full: the timeline and statements show it masked,
  -- the partner needs it whole.
  ADD COLUMN bank_code         text CHECK (bank_code ~ '^[0-9]{3,6}$'),
  ADD COLUMN account_number    text CHECK (account_number ~ '^[0-9]{10}$'),
  -- The partner carrying it (BankPartner.Name) and its ID for the payment.
  ADD COLUMN partner           text,
  ADD COLUMN partner_reference text,
  -- When the saga gives up waiting and gives the money back.
  ADD COLUMN saga_deadline     timestamptz,
  ADD CHECK ((rail = 'interbank') = (bank_code IS NOT NULL AND account_number IS NOT NULL AND partner IS NOT NULL
                                     AND saga_deadline IS NOT NULL)),
  -- Money for another bank is always held first (a duress transfer moves nothing at all).
  ADD CHECK (rail <> 'interbank' OR duress_blocked OR hold_id IS NOT NULL);

-- The saga's work queue in one index: interbank transfers still waiting on the partner.
CREATE INDEX transfers_in_flight ON transfers (saga_deadline) WHERE rail = 'interbank' AND status = 'processing';

-- Partner callbacks already handled. A partner retries until it hears 2xx, so the same
-- event can arrive many times; the first one does the work, the rest find their row here.
CREATE TABLE partner_webhook_events (
  partner     text        NOT NULL,
  event_id    text        NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type  text        NOT NULL,
  reference   text        NOT NULL,
  -- What handling it did: settled, reversed, late (after the saga gave up), ignored.
  outcome     text        NOT NULL CHECK (outcome IN ('settled', 'reversed', 'already_final', 'late_settlement', 'ignored')),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner, event_id)
);

-- +goose Down
DROP TABLE partner_webhook_events;
DROP INDEX transfers_in_flight;
ALTER TABLE transfers DROP COLUMN saga_deadline, DROP COLUMN partner_reference, DROP COLUMN partner,
  DROP COLUMN account_number, DROP COLUMN bank_code;
