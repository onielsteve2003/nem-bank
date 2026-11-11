-- +goose Up
-- Nem Assistant (AI-6). The chat is stored so the customer can scroll back; what the model
-- saw is rebuilt from it each turn (redacted again), never kept as a copy of its own.
CREATE TABLE assistant_conversations (
  id         uuid        PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assistant_conversations_user ON assistant_conversations (user_id, created_at DESC);

CREATE TABLE assistant_messages (
  id              uuid        PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES assistant_conversations (id),
  user_id         uuid        NOT NULL REFERENCES users (id),
  role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
  -- The contract's AssistantBlock list (text, chart, prepared_action, transactions).
  blocks          jsonb       NOT NULL CHECK (jsonb_typeof(blocks) = 'array'),
  -- The AiMeta behind the badge; null on the customer's own messages.
  ai              jsonb,
  -- Which provider answered ('gemini', 'groq', or 'rules' for a canned reply).
  provider        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'assistant') = (ai IS NOT NULL))
);
CREATE INDEX assistant_messages_conversation ON assistant_messages (conversation_id, created_at, id);
-- The per-customer caps count a customer's own messages over a window.
CREATE INDEX assistant_messages_user_sent ON assistant_messages (user_id, created_at) WHERE role = 'user';

-- A money action the assistant drafted. Nothing here has moved any money: confirming runs the
-- normal endpoint with the customer's PIN or biometrics, and only then does status change.
CREATE TABLE prepared_actions (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id),
  conversation_id uuid        NOT NULL REFERENCES assistant_conversations (id),
  kind            text        NOT NULL CHECK (kind IN ('transfer', 'bill_payment', 'savings_deposit', 'card_freeze', 'fx_conversion')),
  summary         text        NOT NULL CHECK (length(summary) <= 300),
  -- The exact request body that confirming will send.
  details         jsonb       NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  status          text        NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'confirmed', 'discarded', 'expired', 'failed')),
  expires_at      timestamptz NOT NULL,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prepared_actions_user ON prepared_actions (user_id, created_at DESC);

-- +goose Down
DROP TABLE prepared_actions;
DROP TABLE assistant_messages;
DROP TABLE assistant_conversations;
