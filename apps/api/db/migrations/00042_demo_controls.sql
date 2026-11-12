-- +goose Up
-- Demo Controls (DEMO-1, T31.5b). Two one-shot switches on a demo customer: the next bank
-- transfer fails at the partner, and the next Tier 3 review ends the way the demo chose.
-- Both are consumed by the first thing that uses them.
ALTER TABLE users
  ADD COLUMN demo_fail_next  boolean NOT NULL DEFAULT false,
  ADD COLUMN demo_kyc_review text CHECK (demo_kyc_review IN ('approve', 'reject', 'resubmit')),
  ADD CONSTRAINT users_demo_switches_only_for_demo CHECK (is_demo OR (NOT demo_fail_next AND demo_kyc_review IS NULL));

-- +goose Down
ALTER TABLE users
  DROP CONSTRAINT users_demo_switches_only_for_demo,
  DROP COLUMN demo_kyc_review,
  DROP COLUMN demo_fail_next;
