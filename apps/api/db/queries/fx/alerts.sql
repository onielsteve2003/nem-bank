-- name: InsertAlert :one
INSERT INTO fx_alerts (id, user_id, pair, direction, target_e8, created_at)
VALUES (@id, @user_id, @pair, @direction, @target_e8, @created_at)
RETURNING *;

-- name: CountActiveAlerts :one
SELECT count(*) FROM fx_alerts WHERE user_id = @user_id AND status = 'active';

-- name: ListAlerts :many
-- Waiting alerts first, then ones that fired since @since, newest first.
SELECT * FROM fx_alerts
WHERE user_id = @user_id AND (status = 'active' OR triggered_at >= @since::timestamptz)
ORDER BY (status = 'active') DESC, created_at DESC, id DESC
LIMIT 10;

-- name: DeleteAlert :execrows
DELETE FROM fx_alerts WHERE id = @id AND user_id = @user_id;

-- name: TriggerAlerts :many
-- Fires every waiting alert on the pair the new mid rate has reached. Once only: the status
-- check keeps a second run from firing it again.
UPDATE fx_alerts
SET status = 'triggered', triggered_at = @now, triggered_rate_e8 = @mid_e8
WHERE pair = @pair AND status = 'active'
  AND ((direction = 'above' AND @mid_e8 >= target_e8) OR (direction = 'below' AND @mid_e8 <= target_e8))
RETURNING *;

-- name: PruneAlerts :execrows
DELETE FROM fx_alerts WHERE status = 'triggered' AND triggered_at < @before;
