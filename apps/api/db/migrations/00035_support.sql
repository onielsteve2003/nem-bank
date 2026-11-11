-- +goose Up
-- Disputes (DSP-1/2), support chat (SUP-1) and the attachments both use.

-- Files customers attach to a dispute or a chat message. Served only through short-lived signed
-- URLs (internal/support). Stored as-is: these are receipts and screenshots, not identity
-- documents (KYC photos are encrypted separately).
CREATE TABLE attachments (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users (id),
  purpose      text        NOT NULL CHECK (purpose IN ('dispute', 'support')),
  file_name    text        NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  content_type text        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes   integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  caption      text        CHECK (length(caption) <= 200),
  data         bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_user ON attachments (user_id, created_at DESC);

-- Case numbers: DSP-10000001 and up, never reused.
CREATE SEQUENCE dispute_case_seq START 10000001;

CREATE TABLE disputes (
  id                    uuid        PRIMARY KEY,
  user_id               uuid        NOT NULL REFERENCES users (id),
  transaction_id        uuid        NOT NULL REFERENCES transactions (id),
  case_number           text        NOT NULL UNIQUE CHECK (case_number ~ '^DSP-[0-9]{8}$'),
  reason                text        NOT NULL CHECK (reason IN (
                          'not_received', 'wrong_amount', 'duplicate_charge', 'unauthorised',
                          'goods_not_received', 'failed_but_debited', 'other')),
  description           text        NOT NULL CHECK (length(description) BETWEEN 10 AND 1000),
  status                text        NOT NULL CHECK (status IN (
                          'submitted', 'under_review', 'awaiting_customer',
                          'resolved_refunded', 'resolved_declined', 'withdrawn')),
  resolution_note       text,
  refund_minor          bigint      CHECK (refund_minor > 0),
  refund_currency       text,
  -- The customer's history line for the refund, once posted.
  refund_transaction_id uuid,
  evidence_ids          uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(evidence_ids) <= 5),
  -- The staff member who decided it; no foreign key, to keep this domain out of the staff realm.
  reviewer_id           uuid,
  created_at            timestamptz NOT NULL,
  resolved_at           timestamptz,
  CHECK ((refund_minor IS NULL) = (refund_currency IS NULL)),
  CHECK ((status IN ('resolved_refunded', 'resolved_declined', 'withdrawn')) = (resolved_at IS NOT NULL))
);
-- One open dispute per transaction (the contract's 409).
CREATE UNIQUE INDEX disputes_one_open ON disputes (transaction_id)
  WHERE status IN ('submitted', 'under_review', 'awaiting_customer');
CREATE INDEX disputes_user ON disputes (user_id, created_at DESC, id DESC);
CREATE INDEX disputes_queue ON disputes (status, created_at, id);
CREATE INDEX disputes_evidence ON disputes USING gin (evidence_ids);

CREATE TABLE dispute_events (
  id         uuid        PRIMARY KEY,
  dispute_id uuid        NOT NULL REFERENCES disputes (id),
  status     text        NOT NULL,
  label      text        NOT NULL,
  detail     text,
  at         timestamptz NOT NULL
);
CREATE INDEX dispute_events_dispute ON dispute_events (dispute_id, at, id);

CREATE TABLE support_conversations (
  id              uuid        PRIMARY KEY,
  user_id         uuid        NOT NULL REFERENCES users (id),
  subject         text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 80),
  status          text        NOT NULL CHECK (status IN ('open', 'waiting_on_customer', 'resolved')),
  -- The assigned agent. agent_name is their first name, copied so the customer's view never
  -- reads the staff table.
  agent_id        uuid,
  agent_name      text,
  transaction_id  uuid,
  last_message_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX support_conversations_user ON support_conversations (user_id, status, last_message_at DESC);
CREATE INDEX support_conversations_agent ON support_conversations (agent_id, status) WHERE agent_id IS NOT NULL;
CREATE INDEX support_conversations_queue ON support_conversations (status, last_message_at);

CREATE TABLE support_messages (
  id               uuid        PRIMARY KEY,
  conversation_id  uuid        NOT NULL REFERENCES support_conversations (id),
  sender           text        NOT NULL CHECK (sender IN ('customer', 'agent', 'system')),
  sender_name      text,
  body             text        NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  attachment_ids   uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(attachment_ids) <= 5),
  created_at       timestamptz NOT NULL,
  -- When the other side read it: the customer for an agent's message, an agent for the customer's.
  read_at          timestamptz
);
CREATE INDEX support_messages_conversation ON support_messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX support_messages_attachments ON support_messages USING gin (attachment_ids);
CREATE INDEX support_messages_unread ON support_messages (conversation_id, sender) WHERE read_at IS NULL;

-- +goose Down
DROP TABLE support_messages;
DROP TABLE support_conversations;
DROP TABLE dispute_events;
DROP TABLE disputes;
DROP SEQUENCE dispute_case_seq;
DROP TABLE attachments;
