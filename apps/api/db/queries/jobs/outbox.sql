-- name: InsertOutboxEvent :exec
INSERT INTO outbox_events (id, topic, aggregate_type, aggregate_id, payload)
VALUES ($1, $2, $3, $4, $5);

-- name: ClaimPendingOutboxEvents :many
-- SKIP LOCKED lets several dispatchers (instances) run at once: each claims a disjoint
-- batch, and a crashed dispatcher's rows unlock when its transaction rolls back.
SELECT id, topic, aggregate_type, aggregate_id, payload, created_at
FROM outbox_events
WHERE dispatched_at IS NULL
ORDER BY created_at, id
LIMIT $1
FOR UPDATE SKIP LOCKED;

-- name: MarkOutboxEventsDispatched :exec
UPDATE outbox_events SET dispatched_at = now() WHERE id = ANY(@ids::uuid[]);

-- name: PruneDispatchedOutboxEvents :execrows
-- Batched so one prune never holds a long lock or bloats WAL on the free-tier database.
DELETE FROM outbox_events
WHERE id IN (
  SELECT o.id FROM outbox_events o
  WHERE o.dispatched_at < @before::timestamptz
  ORDER BY o.dispatched_at
  LIMIT @batch_size
);
