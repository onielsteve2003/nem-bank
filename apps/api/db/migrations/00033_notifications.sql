-- +goose Up
-- Notifications (NOT-1..3). The inbox is the source of truth; push and email are copies of
-- it sent only when the customer's preferences allow.
CREATE TABLE notifications (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id),
  category   text        NOT NULL CHECK (category IN ('transactions', 'security', 'savings', 'ajo', 'credit', 'support', 'product', 'marketing')),
  title      text        NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body       text        NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  deep_link  text,
  -- outbox event + role ("<event id>:sender"). Outbox delivery is at-least-once, so this
  -- unique key is what makes a redelivered event a no-op.
  dedupe_key text        NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_inbox ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- One row per customer, written on first change. Absent = the defaults in code.
CREATE TABLE notification_preferences (
  user_id    uuid        PRIMARY KEY REFERENCES users (id),
  categories jsonb       NOT NULL CHECK (jsonb_typeof(categories) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Expo push tokens, one per device. A token that Expo reports as dead is deleted.
CREATE TABLE push_tokens (
  device_id       uuid        PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users (id),
  expo_push_token text        NOT NULL CHECK (length(expo_push_token) BETWEEN 10 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user ON push_tokens (user_id);

-- +goose Down
DROP TABLE push_tokens;
DROP TABLE notification_preferences;
DROP TABLE notifications;
