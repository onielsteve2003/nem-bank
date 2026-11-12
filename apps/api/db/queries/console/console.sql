-- ---------------------------------------------------------------- customers

-- name: SearchCustomers :many
-- By name, email, phone, nemtag or account number (ADM-3), newest first. The term arrives
-- lower-cased and LIKE-escaped; the first page passes now() and the max UUID.
SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.nemtag, u.kyc_tier, u.frozen_at, u.created_at
FROM users u
WHERE (u.created_at, u.id) < (@after_time::timestamptz, @after_id::uuid)
  AND (
    lower(u.first_name || ' ' || u.last_name) LIKE '%' || @term::text || '%'
    OR u.email LIKE @term::text || '%'
    OR u.phone LIKE '%' || @term::text || '%'
    OR u.nemtag LIKE ltrim(@term::text, chr(64)) || '%'
    OR EXISTS (SELECT 1 FROM customer_accounts a WHERE a.user_id = u.id AND a.account_number = @term::text)
  )
ORDER BY u.created_at DESC, u.id DESC
LIMIT @page_size;

-- name: GetCustomer :one
SELECT id, first_name, last_name, email, phone, nemtag, date_of_birth, kyc_tier, kyc_status, is_demo,
       duress_since, frozen_at, panic_at, created_at
FROM users WHERE id = @id;

-- name: LockCustomer :one
SELECT id, frozen_at FROM users WHERE id = @id FOR UPDATE;

-- name: FreezeCustomer :exec
UPDATE users SET frozen_at = @at, frozen_reason = @reason WHERE id = @id;

-- name: UnfreezeCustomer :exec
UPDATE users SET frozen_at = NULL, frozen_reason = NULL WHERE id = @id;

-- name: SetCustomerAccountsStatus :exec
-- Freezing blocks outgoing money (the transfer path refuses an account that is not active);
-- unfreezing reopens only what the freeze closed.
UPDATE customer_accounts SET status = @to_status WHERE user_id = @user_id AND status = @from_status;

-- name: RevokeAllSessions :exec
UPDATE sessions SET revoked_at = now(), revoke_reason = 'session_revoked' WHERE user_id = @user_id AND revoked_at IS NULL;

-- name: InsertNote :exec
INSERT INTO staff_notes (id, user_id, author_id, body, created_at) VALUES (@id, @user_id, @author_id, @body, @created_at);

-- name: ListNotes :many
SELECT n.id, n.body, n.created_at, n.author_id, s.name AS author_name
FROM staff_notes n JOIN staff s ON s.id = n.author_id
WHERE n.user_id = @user_id ORDER BY n.created_at DESC, n.id DESC LIMIT 50;

-- name: CustomerOpenCases :one
SELECT
  (SELECT count(*) FROM transfers t WHERE t.user_id = @user_id AND t.status = 'held_for_review')::int AS fraud,
  (SELECT count(*) FROM disputes d WHERE d.user_id = @user_id
     AND d.status IN ('submitted', 'under_review', 'awaiting_customer'))::int AS disputes,
  (SELECT count(*) FROM support_conversations c WHERE c.user_id = @user_id AND c.status <> 'resolved')::int AS support;

-- name: CustomerHasLimitOverride :one
SELECT EXISTS (SELECT 1 FROM limit_overrides WHERE user_id = @user_id AND expires_at > @now::timestamptz);

-- name: InsertLimitOverride :exec
INSERT INTO limit_overrides (id, user_id, daily_minor, currency, expires_at, approval_id)
VALUES (@id, @user_id, @daily_minor, 'NGN', @expires_at, @approval_id);

-- ---------------------------------------------------------------- fraud cases

-- name: ListFraudCases :many
-- Held transfers (open or in review) highest risk first, or closed cases newest first. status
-- is 'open', 'in_review', 'released' or 'rejected'.
SELECT t.id AS transfer_id,
       coalesce((t.risk->>'score')::float8, 0)::float8 AS score,
       coalesce(f.closed_at, t.created_at)::timestamptz AS sort_time
FROM transfers t LEFT JOIN fraud_cases f ON f.transfer_id = t.id
WHERE CASE @status::text
        WHEN 'open' THEN t.status = 'held_for_review' AND f.transfer_id IS NULL
        WHEN 'in_review' THEN t.status = 'held_for_review' AND f.status = 'in_review'
        ELSE f.status = @status::text
      END
  AND (CASE WHEN @status::text IN ('open', 'in_review')
            THEN (coalesce((t.risk->>'score')::float8, 0), t.id) < (@after_score::float8, @after_id::uuid)
            ELSE (f.closed_at, t.id) < (@after_time::timestamptz, @after_id::uuid) END)
ORDER BY CASE WHEN @status::text IN ('open', 'in_review') THEN coalesce((t.risk->>'score')::float8, 0) END DESC NULLS LAST,
         f.closed_at DESC NULLS LAST, t.id DESC
LIMIT @page_size;

-- name: GetFraudCase :one
SELECT t.id AS transfer_id, t.user_id, t.created_at AS transfer_created_at,
       coalesce(f.status, 'open')::text AS status, f.assignee_id, s.name AS assignee_name, f.label, f.note,
       f.created_at AS case_created_at, f.closed_at
FROM transfers t
LEFT JOIN fraud_cases f ON f.transfer_id = t.id
LEFT JOIN staff s ON s.id = f.assignee_id
WHERE t.id = @transfer_id AND (t.status = 'held_for_review' OR f.transfer_id IS NOT NULL);

-- name: AssignFraudCase :one
-- Takes an open case, or one already mine; someone else's is left alone (no row back).
INSERT INTO fraud_cases (transfer_id, status, assignee_id, created_at)
SELECT t.id, 'in_review', @staff_id::uuid, @now::timestamptz FROM transfers t WHERE t.id = @transfer_id AND t.status = 'held_for_review'
ON CONFLICT (transfer_id) DO UPDATE SET assignee_id = EXCLUDED.assignee_id, status = 'in_review'
  WHERE fraud_cases.closed_at IS NULL AND (fraud_cases.assignee_id IS NULL OR fraud_cases.assignee_id = EXCLUDED.assignee_id)
RETURNING transfer_id;

-- name: CloseFraudCase :exec
INSERT INTO fraud_cases (transfer_id, status, assignee_id, label, note, customer_message, created_at, closed_at)
VALUES (@transfer_id, @status, @staff_id, @label, @note, @customer_message, @now, @now)
ON CONFLICT (transfer_id) DO UPDATE
SET status = EXCLUDED.status, label = EXCLUDED.label, note = EXCLUDED.note,
    customer_message = EXCLUDED.customer_message, closed_at = EXCLUDED.closed_at,
    assignee_id = coalesce(fraud_cases.assignee_id, EXCLUDED.assignee_id);

-- name: FraudSignals :one
-- What a reviewer needs without opening the customer 360.
SELECT
  coalesce((SELECT extract(epoch FROM (sqlc.arg(now)::timestamptz - d.bound_at)) / 3600 FROM devices d
            WHERE d.id = (SELECT r.device_id FROM risk_assessments r WHERE r.transfer_id = sqlc.arg(transfer_id))), 0)::int AS device_age_hours,
  (SELECT count(*) FROM transfers x WHERE x.user_id = sqlc.arg(user_id) AND x.created_at > sqlc.arg(now)::timestamptz - interval '24 hours')::int AS transfers_last_24h,
  coalesce((SELECT avg(x.amount_minor) FROM transfers x
            WHERE x.user_id = sqlc.arg(user_id) AND x.status = 'completed' AND x.created_at > sqlc.arg(now)::timestamptz - interval '180 days'), 0)::bigint AS average_minor;

-- name: BeneficiaryAgeHours :one
-- Hours since this customer first sent to this beneficiary (by the risk engine's stable key).
SELECT (extract(epoch FROM (sqlc.arg(now)::timestamptz - min(r.created_at))) / 3600)::int AS hours
FROM risk_assessments r
WHERE r.user_id = sqlc.arg(user_id) AND r.beneficiary_key = (SELECT x.beneficiary_key FROM risk_assessments x WHERE x.transfer_id = sqlc.arg(transfer_id))
HAVING count(*) > 0;

-- name: LabelRisk :exec
UPDATE risk_assessments SET label = @label, labeled_by = @staff_id, labeled_at = @now, label_note = @note
WHERE transfer_id = @transfer_id;

-- ---------------------------------------------------------------- dashboard

-- name: DashboardUsers :one
SELECT count(*)::int AS total,
       coalesce(sum(CASE WHEN created_at >= sqlc.arg(from_time)::timestamptz AND created_at < sqlc.arg(to_time)::timestamptz THEN 1 ELSE 0 END), 0)::int AS new_users,
       (SELECT count(DISTINCT user_id) FROM sessions WHERE last_active_at > sqlc.arg(now)::timestamptz - interval '30 days')::int AS active_30d
FROM users WHERE NOT is_dependant;

-- name: DashboardVolume :many
-- Money through customer accounts in the period, by currency.
SELECT p.currency,
       coalesce(sum(CASE WHEN p.amount_minor > 0 THEN p.amount_minor END), 0)::bigint AS inflow,
       coalesce(sum(CASE WHEN p.amount_minor < 0 THEN -p.amount_minor END), 0)::bigint AS outflow,
       count(DISTINCT p.entry_id)::int AS entries
FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
WHERE a.owner_type = 'customer' AND p.created_at >= @from_time::timestamptz AND p.created_at < @to_time::timestamptz
GROUP BY p.currency ORDER BY p.currency;

-- name: DashboardTransfersByStatus :many
SELECT status, count(*)::int AS n FROM transfers
WHERE created_at >= @from_time::timestamptz AND created_at < @to_time::timestamptz
GROUP BY status ORDER BY status;

-- name: DashboardFraudRate :one
SELECT coalesce(sum(CASE WHEN enforced = 'hold' THEN 1 ELSE 0 END), 0)::int AS held, count(*)::int AS scored
FROM risk_assessments WHERE created_at >= @from_time::timestamptz AND created_at < @to_time::timestamptz;

-- name: DashboardQueues :one
SELECT
  (SELECT count(*) FROM kyc_submissions WHERE status = 'pending_review')::int AS kyc_pending,
  (SELECT count(*) FROM transfers WHERE status = 'held_for_review')::int AS fraud_open,
  (SELECT count(*) FROM disputes WHERE status IN ('submitted', 'under_review', 'awaiting_customer'))::int AS disputes_open,
  (SELECT count(*) FROM support_conversations WHERE status <> 'resolved')::int AS support_open,
  (SELECT count(*) FROM approval_requests WHERE status = 'pending' AND expires_at > sqlc.arg(now)::timestamptz)::int AS approvals_pending;

-- ---------------------------------------------------------------- ledger explorer

-- name: ListLedgerAccounts :many
SELECT id, owner_type, owner_id, kind, currency, name, balance_minor, available_minor, version, created_at
FROM ledger_accounts
WHERE (@owner_type::text = '' OR owner_type = @owner_type::text)
  AND (@owner_id::uuid = '00000000-0000-0000-0000-000000000000'::uuid OR owner_id = @owner_id::uuid)
  AND (@currency::text = '' OR currency = @currency::text)
  AND (created_at, id) > (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at, id
LIMIT @page_size;

-- name: LedgerAccountExists :one
SELECT EXISTS (SELECT 1 FROM ledger_accounts WHERE id = @id);

-- name: ListLedgerPostings :many
SELECT id, entry_id, account_id, amount_minor, currency, balance_after_minor, created_at
FROM postings
WHERE account_id = @account_id AND created_at >= @from_time::timestamptz AND created_at < @to_time::timestamptz
  AND (created_at, id) < (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at DESC, id DESC
LIMIT @page_size;

-- name: ListJournalEntries :many
SELECT id, kind, reference, idempotency_key, approval_id, metadata, created_at
FROM journal_entries
WHERE (@kind::text = '' OR kind = @kind::text)
  AND (@reference::text = '' OR reference = @reference::text)
  AND created_at >= @from_time::timestamptz AND created_at < @to_time::timestamptz
  AND (created_at, id) < (@after_time::timestamptz, @after_id::uuid)
ORDER BY created_at DESC, id DESC
LIMIT @page_size;

-- name: GetJournalEntry :one
SELECT id, kind, reference, idempotency_key, approval_id, metadata, created_at FROM journal_entries WHERE id = @id;

-- name: ListEntryPostings :many
SELECT id, entry_id, account_id, amount_minor, currency, balance_after_minor, created_at
FROM postings WHERE entry_id = ANY(@entry_ids::uuid[]) ORDER BY entry_id, amount_minor, id;

-- name: TrialBalance :many
-- Per currency: every posting up to as_of. Debits are the negative postings, credits the
-- positive ones; the ledger is sound only when they cancel exactly.
SELECT p.currency,
       coalesce(sum(CASE WHEN p.amount_minor < 0 THEN -p.amount_minor END), 0)::bigint AS total_debits,
       coalesce(sum(CASE WHEN p.amount_minor > 0 THEN p.amount_minor END), 0)::bigint AS total_credits,
       coalesce(sum(p.amount_minor), 0)::bigint AS net,
       count(DISTINCT p.account_id)::int AS accounts
FROM postings p WHERE p.created_at <= @as_of::timestamptz
GROUP BY p.currency ORDER BY p.currency;

-- name: ListAccountCurrencies :many
SELECT id, currency FROM ledger_accounts WHERE id = ANY(@ids::uuid[]);

-- ---------------------------------------------------------------- configuration and flags

-- name: GetBankConfig :one
SELECT version, value, updated_at FROM bank_config WHERE id = 1;

-- name: SeedBankConfig :exec
INSERT INTO bank_config (id, version, value) VALUES (1, 1, @value) ON CONFLICT (id) DO NOTHING;

-- name: ApplyBankConfig :one
-- Only against the version the change was made on: a stale change updates nothing.
UPDATE bank_config SET version = version + 1, value = @value, updated_at = @now
WHERE id = 1 AND version = @base_version RETURNING version;

-- name: ListFeatureFlags :many
SELECT f.key, f.description, f.enabled, f.paid_feature, f.updated_at, f.updated_by, s.name AS updated_by_name
FROM feature_flags f LEFT JOIN staff s ON s.id = f.updated_by ORDER BY f.key;

-- name: GetFeatureFlag :one
SELECT key, description, enabled, paid_feature FROM feature_flags WHERE key = @key FOR UPDATE;

-- name: SetFeatureFlag :exec
UPDATE feature_flags SET enabled = @enabled, updated_at = @now, updated_by = @staff_id WHERE key = @key;

-- ---------------------------------------------------------------- audit log

-- name: ListAuditEntries :many
SELECT * FROM audit_log
WHERE (@actor_id::text = '' OR actor_id = @actor_id::text)
  AND (@action::text = '' OR action = @action::text)
  AND (@resource_id::text = '' OR resource_id = @resource_id::text)
  AND at >= @from_time::timestamptz AND at < @to_time::timestamptz
  AND seq < @after_seq::bigint
ORDER BY seq DESC
LIMIT @page_size;

-- name: GetStaffRef :one
SELECT id, name FROM staff WHERE id = @id;
