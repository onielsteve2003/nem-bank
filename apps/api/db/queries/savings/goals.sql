-- name: InsertGoal :one
INSERT INTO savings_goals (
  id, user_id, account_id, name, emoji, target_minor, target_date,
  auto_save_amount_minor, auto_save_frequency, auto_save_source_id, auto_save_next_at,
  interest_paid_to, created_at
) VALUES (
  @id, @user_id, @account_id, @name, @emoji, @target_minor, sqlc.narg('target_date'),
  sqlc.narg('auto_save_amount_minor'), sqlc.narg('auto_save_frequency'), sqlc.narg('auto_save_source_id'), sqlc.narg('auto_save_next_at'),
  @interest_paid_to, @created_at
)
RETURNING *;

-- name: GetGoal :one
SELECT sqlc.embed(g), l.balance_minor
FROM savings_goals g JOIN ledger_accounts l ON l.id = g.account_id
WHERE g.id = @id AND g.user_id = @user_id;

-- name: LockGoal :one
-- Held while a deposit, withdrawal, edit or auto-save runs, so they apply one at a time.
SELECT * FROM savings_goals WHERE id = @id FOR UPDATE;

-- name: ListGoals :many
-- Active goals first, newest first within each.
SELECT sqlc.embed(g), l.balance_minor
FROM savings_goals g JOIN ledger_accounts l ON l.id = g.account_id
WHERE g.user_id = @user_id
ORDER BY (g.status = 'active') DESC, g.created_at DESC, g.id DESC;

-- name: CountActiveGoals :one
SELECT count(*) FROM savings_goals WHERE user_id = @user_id AND status = 'active';

-- name: UpdateGoal :one
UPDATE savings_goals
SET name = @name, emoji = @emoji, target_minor = @target_minor, target_date = sqlc.narg('target_date'),
    auto_save_amount_minor = sqlc.narg('auto_save_amount_minor'), auto_save_frequency = sqlc.narg('auto_save_frequency'),
    auto_save_source_id = sqlc.narg('auto_save_source_id'), auto_save_next_at = sqlc.narg('auto_save_next_at')
WHERE id = @id
RETURNING *;

-- name: CloseGoal :one
-- Closing ends the auto-save rule with it.
UPDATE savings_goals
SET status = 'closed', closed_at = @at,
    auto_save_amount_minor = NULL, auto_save_frequency = NULL, auto_save_source_id = NULL, auto_save_next_at = NULL
WHERE id = @id
RETURNING *;

-- name: ListDueAutoSaves :many
SELECT id FROM savings_goals
WHERE status = 'active' AND auto_save_next_at <= @now
ORDER BY auto_save_next_at
LIMIT 200;

-- name: SetAutoSaveNext :exec
UPDATE savings_goals SET auto_save_next_at = @next WHERE id = @id;

-- name: GetRoundUpSettings :one
SELECT * FROM round_up_settings WHERE user_id = @user_id;

-- name: UpsertRoundUpSettings :one
INSERT INTO round_up_settings (user_id, enabled, round_to_minor, goal_id, sources, enabled_since, updated_at)
VALUES (@user_id, @enabled, @round_to_minor, sqlc.narg('goal_id'), @sources, sqlc.narg('enabled_since'), @updated_at)
ON CONFLICT (user_id) DO UPDATE
SET enabled = EXCLUDED.enabled, round_to_minor = EXCLUDED.round_to_minor, goal_id = EXCLUDED.goal_id,
    sources = EXCLUDED.sources, enabled_since = EXCLUDED.enabled_since, updated_at = EXCLUDED.updated_at
RETURNING *;

-- name: InsertRoundUp :execrows
-- Zero rows means this spend was already rounded up.
INSERT INTO round_ups (id, user_id, goal_id, source_ref, amount_minor, entry_id, created_at)
VALUES (@id, @user_id, @goal_id, @source_ref, @amount_minor, @entry_id, @created_at)
ON CONFLICT (source_ref) DO NOTHING;

-- name: SumRoundUpsSince :one
SELECT coalesce(sum(amount_minor), 0)::bigint FROM round_ups WHERE user_id = @user_id AND created_at >= @since;

-- name: GoalTotals :one
-- What the Grow tab adds up: money in open goals and the interest they have earned.
SELECT coalesce(sum(l.balance_minor), 0)::bigint AS saved,
       coalesce(sum(g.interest_earned_minor), 0)::bigint AS interest,
       count(*)::int AS goals
FROM savings_goals g JOIN ledger_accounts l ON l.id = g.account_id
WHERE g.user_id = @user_id AND g.status = 'active';

-- name: ClearRoundUpGoal :exec
-- A closed goal can no longer take round-ups, so the rule is switched off.
UPDATE round_up_settings SET enabled = false, goal_id = NULL, enabled_since = NULL WHERE goal_id = @goal_id;
