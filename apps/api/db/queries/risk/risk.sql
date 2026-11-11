-- name: Signals :one
-- Everything the model needs about a customer's earlier activity, in one pass over the
-- last 180 days of their transfers (the current transfer is not inserted yet).
SELECT
  count(*)::bigint                                                         AS prior_count,
  coalesce(sum(ln(1 + amount_minor::float8 / 100.0)), 0)::float8           AS sum_log,
  coalesce(sum(power(ln(1 + amount_minor::float8 / 100.0), 2)), 0)::float8 AS sum_log_sq,
  (count(*) FILTER (WHERE created_at >= sqlc.arg(at)::timestamptz - interval '1 hour'))::bigint   AS last_hour,
  (count(*) FILTER (WHERE created_at >= sqlc.arg(at)::timestamptz - interval '24 hours'))::bigint AS last_day
FROM transfers
WHERE user_id = @user_id
  AND created_at < sqlc.arg(at)::timestamptz
  AND created_at >= sqlc.arg(at)::timestamptz - interval '180 days';

-- name: KnowsBeneficiary :one
SELECT EXISTS (SELECT 1 FROM risk_assessments WHERE user_id = @user_id AND beneficiary_key = @beneficiary_key);

-- name: KnowsDevice :one
SELECT EXISTS (SELECT 1 FROM risk_assessments WHERE user_id = @user_id AND device_id = @device_id);

-- name: CustomerSince :one
SELECT created_at FROM users WHERE id = @user_id;

-- name: InsertAssessment :exec
INSERT INTO risk_assessments (
  transfer_id, user_id, device_id, beneficiary_key, mode, model_version, model_used, score, rules_score,
  decision, enforced, reasons, features, duration_us
) VALUES (
  @transfer_id, @user_id, @device_id, @beneficiary_key, @mode, @model_version, @model_used, @score, @rules_score,
  @decision, @enforced, @reasons, @features, @duration_us
);

-- name: GetAssessment :one
SELECT * FROM risk_assessments WHERE transfer_id = @transfer_id;

-- name: LabelAssessment :execrows
UPDATE risk_assessments
SET label = @label, labeled_by = @labeled_by, labeled_at = now(), label_note = @label_note
WHERE transfer_id = @transfer_id;

-- name: ListLabeled :many
-- The retraining set: what the model saw, what it said, and what staff decided.
SELECT transfer_id, features, score, decision, label, created_at
FROM risk_assessments
WHERE label IS NOT NULL
ORDER BY labeled_at, transfer_id;
