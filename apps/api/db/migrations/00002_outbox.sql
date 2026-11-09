-- +goose Up
-- Transactional outbox: a domain writes its state change and the event describing it in
-- one transaction, so an event exists if and only if the change committed. The dispatcher
-- (internal/jobs) turns pending rows into River jobs, again in one transaction.
CREATE TABLE outbox_events (
  id             uuid        PRIMARY KEY,           -- UUIDv7, set by the writer
  topic          text        NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_type text        NOT NULL,
  aggregate_id   text        NOT NULL,
  payload        jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz
);

-- The dispatcher's claim query reads only pending rows, oldest first.
CREATE INDEX outbox_events_pending ON outbox_events (created_at, id) WHERE dispatched_at IS NULL;
-- Pruning reads only dispatched rows by age.
CREATE INDEX outbox_events_dispatched ON outbox_events (dispatched_at) WHERE dispatched_at IS NOT NULL;

-- +goose Down
DROP TABLE outbox_events;
