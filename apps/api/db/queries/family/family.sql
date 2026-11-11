-- name: LockGuardian :one
-- Serialises a guardian's changes (the five-dependant cap, an allowance) on their own row.
SELECT id FROM users WHERE id = @id AND NOT is_dependant FOR UPDATE;

-- name: CountDependants :one
SELECT count(*) FROM dependants WHERE guardian_id = @guardian_id;

-- name: InsertDependantUser :one
-- The dependant takes the guardian's email, phone and consent record; the password hash matches
-- nothing, so the child never signs in with a password. Returns the new user's id.
INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth, nemtag, password_hash,
                   terms_version, privacy_version, consent_accepted_at, is_dependant, guardian_id)
SELECT @id, @first_name, @last_name, g.email, g.phone, @date_of_birth, @nemtag, '!',
       g.terms_version, g.privacy_version, g.consent_accepted_at, true, g.id
FROM users g WHERE g.id = @guardian_id AND NOT g.is_dependant
RETURNING id;

-- name: InsertDependant :exec
INSERT INTO dependants (id, guardian_id, user_id, account_id, kid_mode, daily_spend_limit_minor,
                        approval_threshold_minor, can_send_to_banks, setup_code_hash, setup_code_expires_at, created_at)
VALUES (@id, @guardian_id, @user_id, @account_id, true, @daily_spend_limit_minor,
        @approval_threshold_minor, @can_send_to_banks, @setup_code_hash, @setup_code_expires_at, @created_at);

-- name: ListDependants :many
SELECT d.*, u.first_name, u.last_name, u.nemtag, u.date_of_birth
FROM dependants d JOIN users u ON u.id = d.user_id
WHERE d.guardian_id = @guardian_id
ORDER BY d.created_at, d.id;

-- name: GetDependant :one
SELECT d.*, u.first_name, u.last_name, u.nemtag, u.date_of_birth
FROM dependants d JOIN users u ON u.id = d.user_id
WHERE d.id = @id AND d.guardian_id = @guardian_id;

-- name: GetDependantForUpdate :one
SELECT * FROM dependants WHERE id = @id AND guardian_id = @guardian_id FOR UPDATE;

-- name: GetDependantByUser :one
SELECT * FROM dependants WHERE user_id = @user_id;

-- name: UpdateControls :exec
UPDATE dependants SET
  kid_mode = COALESCE(sqlc.narg(kid_mode)::boolean, kid_mode),
  daily_spend_limit_minor = COALESCE(sqlc.narg(daily_spend_limit_minor)::bigint, daily_spend_limit_minor),
  approval_threshold_minor = COALESCE(sqlc.narg(approval_threshold_minor)::bigint, approval_threshold_minor),
  can_send_to_banks = COALESCE(sqlc.narg(can_send_to_banks)::boolean, can_send_to_banks),
  paused = COALESCE(sqlc.narg(paused)::boolean, paused)
WHERE id = @id;

-- name: SetAllowance :exec
UPDATE dependants SET allowance_amount_minor = @amount_minor, allowance_frequency = @frequency,
  allowance_day = @day, allowance_source_account_id = @source_account_id, allowance_next_run_at = @next_run_at
WHERE id = @id;

-- name: ClearAllowance :exec
UPDATE dependants SET allowance_amount_minor = NULL, allowance_frequency = NULL, allowance_day = NULL,
  allowance_source_account_id = NULL, allowance_next_run_at = NULL
WHERE id = @id;

-- name: ListDueAllowances :many
SELECT id, guardian_id FROM dependants
WHERE allowance_next_run_at IS NOT NULL AND allowance_next_run_at <= @now
ORDER BY allowance_next_run_at, id
LIMIT @lim;

-- name: ClaimAllowanceRun :one
-- Takes the run that was due at @expected and schedules the next one, in the caller's transaction:
-- the transfer and this claim commit together, so a run happens once or not at all.
UPDATE dependants SET allowance_next_run_at = @next_run_at
WHERE id = @id AND allowance_next_run_at = @expected
RETURNING *;

-- name: InsertApproval :one
INSERT INTO family_approvals (id, dependant_id, guardian_id, user_id, source_account_id, destination, recipient,
                              amount_minor, narration, category, status, hold_id, created_at, expires_at)
VALUES (@id, @dependant_id, @guardian_id, @user_id, @source_account_id, @destination, @recipient,
        @amount_minor, @narration, @category, 'pending', @hold_id, @created_at, @expires_at)
RETURNING *;

-- name: GetApprovalForUpdate :one
SELECT * FROM family_approvals WHERE id = @id AND guardian_id = @guardian_id FOR UPDATE;

-- name: GetApprovalAny :one
SELECT * FROM family_approvals WHERE id = @id;

-- name: FindPendingApproval :one
-- The same request asked again (a retry) finds the approval it already made.
SELECT * FROM family_approvals
WHERE user_id = @user_id AND status = 'pending' AND amount_minor = @amount_minor
  AND destination = @destination AND narration = @narration AND expires_at > @now
ORDER BY created_at DESC LIMIT 1;

-- name: SumPendingApprovals :one
SELECT COALESCE(sum(amount_minor), 0)::bigint FROM family_approvals
WHERE user_id = @user_id AND status = 'pending' AND expires_at > @now;

-- name: ListApprovals :many
-- A guardian's dependants' requests and the caller's own, pending first.
SELECT a.*, u.first_name, u.last_name, u.nemtag
FROM family_approvals a JOIN users u ON u.id = a.user_id
WHERE (a.guardian_id = @user_id OR a.user_id = @user_id)
  AND (sqlc.narg(status)::text IS NULL OR a.status = sqlc.narg(status)::text)
ORDER BY (a.status = 'pending') DESC, a.created_at DESC, a.id DESC
LIMIT 100;

-- name: DecideApproval :one
UPDATE family_approvals SET status = @status, decided_at = @at, transfer_id = @transfer_id
WHERE id = @id AND status = 'pending'
RETURNING *;

-- name: ListExpiredApprovals :many
SELECT id, guardian_id FROM family_approvals WHERE status = 'pending' AND expires_at <= @now ORDER BY expires_at LIMIT @lim;

-- name: GetUserName :one
SELECT first_name, last_name, nemtag FROM users WHERE id = @id;

-- name: GetDependantByID :one
SELECT * FROM dependants WHERE id = @id;

-- name: GetNairaAccount :one
SELECT account_id, account_number FROM customer_accounts WHERE user_id = @user_id AND currency = 'NGN';
