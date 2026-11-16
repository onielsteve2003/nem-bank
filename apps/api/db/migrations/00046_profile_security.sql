-- +goose Up
-- Profile photo (PRF-2), the security question (SEC-3) and alert preferences (SEC-6). The photo is
-- a JPEG or PNG data URI of up to 1 MB, which is up to ~1.4 million characters once base64 encoded.
-- The answer is only ever stored as an Argon2id hash of its normalised form.
ALTER TABLE users
  ADD COLUMN avatar_url            text    CHECK (length(avatar_url) <= 1400000),
  ADD COLUMN security_question     text    CHECK (length(security_question) <= 120),
  ADD COLUMN security_answer_hash  text,
  ADD COLUMN login_alerts          boolean NOT NULL DEFAULT true,
  ADD COLUMN new_device_alerts     boolean NOT NULL DEFAULT true,
  ADD COLUMN alert_threshold_minor bigint  NOT NULL DEFAULT 0 CHECK (alert_threshold_minor >= 0),
  ADD CONSTRAINT users_question_has_answer CHECK ((security_question IS NULL) = (security_answer_hash IS NULL));

-- +goose Down
ALTER TABLE users
  DROP CONSTRAINT users_question_has_answer,
  DROP COLUMN alert_threshold_minor,
  DROP COLUMN new_device_alerts,
  DROP COLUMN login_alerts,
  DROP COLUMN security_answer_hash,
  DROP COLUMN security_question,
  DROP COLUMN avatar_url;
