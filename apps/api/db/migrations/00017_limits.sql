-- +goose Up
-- Limits (T25.5). A customer's outgoing naira is capped per Lagos calendar day by the
-- lowest of their KYC tier cap, their own limit (SEC-3) and any new-device cool-off
-- (AUTH-8), and per transfer by their own single limit.

-- The customer's own limits. Lowering applies at once; raising (or removing) waits 24
-- hours as a pending increase, so someone who gets into the app cannot raise and spend.
CREATE TABLE self_limits (
  user_id              uuid        PRIMARY KEY REFERENCES users (id),
  daily_minor          bigint      CHECK (daily_minor > 0),
  single_minor         bigint      CHECK (single_minor > 0),
  pending_daily_minor  bigint      CHECK (pending_daily_minor > 0),
  pending_single_minor bigint      CHECK (pending_single_minor > 0),
  -- Set while an increase waits; null pending values then mean "no limit".
  pending_effective_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (single_minor IS NULL OR daily_minor IS NULL OR single_minor <= daily_minor),
  CHECK (pending_single_minor IS NULL OR pending_daily_minor IS NULL OR pending_single_minor <= pending_daily_minor),
  CHECK (pending_effective_at IS NOT NULL OR (pending_daily_minor IS NULL AND pending_single_minor IS NULL))
);

-- The daily rollup: what each customer has sent per Lagos day. A transfer adds to it in
-- its own database transaction, guarded by the limit in the same statement, so two
-- transfers racing for the last naira of the day cannot both pass. A transfer that fails
-- or is reversed gives its amount back to the day it was counted on.
CREATE TABLE daily_limit_usage (
  user_id    uuid        NOT NULL REFERENCES users (id),
  day        date        NOT NULL,
  used_minor bigint      NOT NULL CHECK (used_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- The Lagos day a transfer was counted on, so a reversal gives back to the right day.
ALTER TABLE transfers ADD COLUMN limit_day date;

-- +goose Down
ALTER TABLE transfers DROP COLUMN limit_day;
DROP TABLE daily_limit_usage;
DROP TABLE self_limits;
