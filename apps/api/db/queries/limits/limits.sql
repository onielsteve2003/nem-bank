-- name: GetSelfLimits :one
SELECT * FROM self_limits WHERE user_id = $1;

-- name: ApplyDueIncrease :one
-- A pending increase whose 24 hours are up becomes the limits.
UPDATE self_limits
SET daily_minor = pending_daily_minor, single_minor = pending_single_minor,
    pending_daily_minor = NULL, pending_single_minor = NULL, pending_effective_at = NULL, updated_at = now()
WHERE user_id = @user_id AND pending_effective_at <= @now::timestamptz
RETURNING *;

-- name: SetSelfLimits :one
-- Tightening: applies now and cancels any waiting increase.
INSERT INTO self_limits (user_id, daily_minor, single_minor)
VALUES (@user_id, sqlc.narg('daily_minor'), sqlc.narg('single_minor'))
ON CONFLICT (user_id) DO UPDATE
SET daily_minor = EXCLUDED.daily_minor, single_minor = EXCLUDED.single_minor,
    pending_daily_minor = NULL, pending_single_minor = NULL, pending_effective_at = NULL, updated_at = now()
RETURNING *;

-- name: SetPendingIncrease :one
INSERT INTO self_limits (user_id, pending_daily_minor, pending_single_minor, pending_effective_at)
VALUES (@user_id, sqlc.narg('pending_daily_minor'), sqlc.narg('pending_single_minor'), @effective_at::timestamptz)
ON CONFLICT (user_id) DO UPDATE
SET pending_daily_minor = EXCLUDED.pending_daily_minor, pending_single_minor = EXCLUDED.pending_single_minor,
    pending_effective_at = EXCLUDED.pending_effective_at, updated_at = now()
RETURNING *;

-- name: GetDailyUsage :one
SELECT coalesce((SELECT used_minor FROM daily_limit_usage WHERE user_id = @user_id AND day = @day), 0)::bigint;

-- name: ConsumeDailyLimit :one
-- Adds amount to the day only if the day stays within the limit. ON CONFLICT locks the
-- row and re-checks the guard on the latest value, so a racing transfer waits and then
-- sees what the first one used. No row means the limit would be exceeded.
INSERT INTO daily_limit_usage (user_id, day, used_minor)
SELECT @user_id, @day, @amount_minor::bigint
WHERE @amount_minor::bigint <= @limit_minor::bigint
ON CONFLICT (user_id, day) DO UPDATE
SET used_minor = daily_limit_usage.used_minor + EXCLUDED.used_minor, updated_at = now()
WHERE daily_limit_usage.used_minor + EXCLUDED.used_minor <= @limit_minor::bigint
RETURNING used_minor;

-- name: ReleaseDailyLimit :exec
UPDATE daily_limit_usage
SET used_minor = greatest(used_minor - @amount_minor::bigint, 0), updated_at = now()
WHERE user_id = @user_id AND day = @day;
