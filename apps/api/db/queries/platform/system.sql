-- name: ServerTime :one
-- The database clock. Readiness checks use it to prove a real round trip, not just a pooled connection.
SELECT now()::timestamptz AS now;
