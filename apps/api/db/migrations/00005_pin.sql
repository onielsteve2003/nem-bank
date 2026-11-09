-- +goose Up
-- Transaction PIN (AUTH-4) and duress PIN (SEC-5), both argon2id. A 4-digit PIN has only
-- 10^4 values, so the hash alone cannot protect it offline; what protects it is the
-- online lockout below plus the server-side hash never leaving the database.
ALTER TABLE users
  ADD COLUMN pin_hash         text,
  ADD COLUMN pin_failures     smallint NOT NULL DEFAULT 0 CHECK (pin_failures BETWEEN 0 AND 5),
  -- Lockouts in a row; each lasts four times longer (30 min, 2 h, 8 h, then 24 h).
  ADD COLUMN pin_lockouts     smallint NOT NULL DEFAULT 0 CHECK (pin_lockouts >= 0),
  ADD COLUMN pin_locked_until timestamptz,
  ADD COLUMN duress_pin_hash  text,
  -- Set while the customer is in duress mode: transfers are silently blocked and balances
  -- show the decoy view, on every device, until the real PIN is entered again.
  ADD COLUMN duress_since     timestamptz;

-- Which action a step-up code unlocks (contract StepUpPurpose), so a token earned for one
-- action never authorises another.
ALTER TABLE otp_challenges
  ADD COLUMN step_up_purpose text CHECK (step_up_purpose IN
    ('transfer', 'new_beneficiary', 'device_bind', 'pin_reset', 'card_reveal', 'unfreeze',
     'limit_increase', 'account_deletion')),
  ADD CONSTRAINT otp_challenges_step_up_purpose
    CHECK ((purpose = 'step_up') = (step_up_purpose IS NOT NULL));

-- +goose Down
ALTER TABLE otp_challenges
  DROP CONSTRAINT otp_challenges_step_up_purpose,
  DROP COLUMN step_up_purpose;
ALTER TABLE users
  DROP COLUMN duress_since,
  DROP COLUMN duress_pin_hash,
  DROP COLUMN pin_locked_until,
  DROP COLUMN pin_lockouts,
  DROP COLUMN pin_failures,
  DROP COLUMN pin_hash;
