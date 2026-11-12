-- +goose Up
-- Panic mode (SEC-4, T30.5a). Set while it is on: every outgoing payment is refused and the
-- cards it froze stay frozen until the customer releases it behind a step-up.
ALTER TABLE users ADD COLUMN panic_at timestamptz;

-- +goose Down
ALTER TABLE users DROP COLUMN panic_at;
