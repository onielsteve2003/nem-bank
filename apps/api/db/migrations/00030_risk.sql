-- +goose Up
-- Fraud risk scoring (AI-1). One row per scored transfer: the score, the decision the
-- engine made, the decision actually enforced (they differ in shadow mode), the reasons
-- shown to the customer and staff, and the exact features the model saw. Staff labels
-- (fraud or legit) are added by the console and feed retraining.
CREATE TABLE risk_assessments (
  transfer_id     uuid        PRIMARY KEY REFERENCES transfers (id),
  user_id         uuid        NOT NULL REFERENCES users (id),
  device_id       uuid,
  -- Who the money goes to, so "first payment to this person" survives a deleted beneficiary.
  beneficiary_key text        NOT NULL,
  mode            text        NOT NULL CHECK (mode IN ('enforce', 'shadow')),
  model_version   text        NOT NULL,
  model_used      boolean     NOT NULL,
  score           double precision NOT NULL CHECK (score BETWEEN 0 AND 1),
  rules_score     double precision NOT NULL CHECK (rules_score BETWEEN 0 AND 1),
  decision        text        NOT NULL CHECK (decision IN ('allow', 'step_up', 'hold')),
  enforced        text        NOT NULL CHECK (enforced IN ('allow', 'step_up', 'hold')),
  reasons         jsonb       NOT NULL,
  features        jsonb       NOT NULL,
  duration_us     bigint      NOT NULL CHECK (duration_us >= 0),
  label           text        CHECK (label IN ('fraud', 'legit')),
  labeled_by      uuid,
  labeled_at      timestamptz,
  label_note      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((label IS NULL) = (labeled_at IS NULL))
);
CREATE INDEX risk_assessments_user_beneficiary ON risk_assessments (user_id, beneficiary_key);
CREATE INDEX risk_assessments_user_device ON risk_assessments (user_id, device_id);
CREATE INDEX risk_assessments_labeled ON risk_assessments (labeled_at) WHERE label IS NOT NULL;

-- Signals are read by customer and time.
CREATE INDEX IF NOT EXISTS transfers_user_created ON transfers (user_id, created_at);

-- +goose Down
DROP INDEX IF EXISTS transfers_user_created;
DROP TABLE risk_assessments;
