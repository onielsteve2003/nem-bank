-- +goose Up
-- The contract's StepUpPurpose gained api_key (T30.6a), so creating an API key no longer
-- borrows the device_bind purpose.
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_step_up_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_step_up_purpose_check
  CHECK (step_up_purpose IN
    ('transfer', 'new_beneficiary', 'device_bind', 'pin_reset', 'card_reveal', 'unfreeze',
     'limit_increase', 'account_deletion', 'api_key'));

-- +goose Down
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_step_up_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_step_up_purpose_check
  CHECK (step_up_purpose IN
    ('transfer', 'new_beneficiary', 'device_bind', 'pin_reset', 'card_reveal', 'unfreeze',
     'limit_increase', 'account_deletion'));
