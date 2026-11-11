-- ---------------------------------------------------------------- requests

-- name: InsertRequest :one
INSERT INTO privacy_requests (id, user_id, kind, requested_at, completes_by)
VALUES (@id, sqlc.arg(user_id), @kind, @requested_at, @completes_by) RETURNING *;

-- name: GetRequest :one
SELECT * FROM privacy_requests WHERE id = @id;

-- name: RecentExportRequests :many
SELECT requested_at FROM privacy_requests
WHERE user_id = sqlc.arg(user_id) AND kind = 'export' AND requested_at > sqlc.arg(since)::timestamptz ORDER BY requested_at;

-- name: OpenDeletionRequest :one
SELECT count(*)::int FROM privacy_requests WHERE privacy_requests.user_id = sqlc.arg(user_id) AND kind = 'deletion' AND status IN ('received', 'processing', 'completed');

-- name: SetRequestStatus :exec
UPDATE privacy_requests SET status = sqlc.arg(new_status), completed_at = sqlc.narg(done_at), rejection_reason = sqlc.narg(reason)
WHERE id = sqlc.arg(id);

-- name: StoreExport :exec
INSERT INTO privacy_exports (request_id, user_id, ciphertext, expires_at) VALUES (@request_id, sqlc.arg(user_id), @ciphertext, @expires_at)
ON CONFLICT (request_id) DO NOTHING;

-- name: TakeExport :one
-- One download only: the archive is deleted as it is read.
DELETE FROM privacy_exports WHERE request_id = sqlc.arg(request_id) AND expires_at > sqlc.arg(now)::timestamptz RETURNING user_id, ciphertext;

-- name: PruneExports :exec
DELETE FROM privacy_exports WHERE expires_at <= sqlc.arg(now)::timestamptz;

-- name: GetOwnerEmail :one
SELECT email, first_name FROM users WHERE id = @id AND deleted_at IS NULL;

-- ---------------------------------------------------------------- deletion eligibility

-- name: DeletionBlockers :one
-- What stops an account closing: money anywhere, anything still in flight, obligations, and
-- dependants who answer to this customer.
SELECT
  (SELECT count(*) FROM customer_accounts a JOIN ledger_accounts l ON l.id = a.account_id
     WHERE a.user_id = sqlc.arg(user_id) AND (l.balance_minor <> 0 OR l.available_minor <> 0))::int AS accounts_with_money,
  (SELECT count(*) FROM ledger_accounts l WHERE l.owner_id = sqlc.arg(user_id) AND l.kind <> 'customer_current' AND l.kind <> 'customer_wallet'
     AND (l.balance_minor <> 0 OR l.available_minor <> 0))::int AS other_balances,
  (SELECT count(*) FROM loans WHERE loans.user_id = sqlc.arg(user_id) AND status <> 'repaid')::int AS open_loans,
  (SELECT count(*) FROM locked_savings WHERE locked_savings.user_id = sqlc.arg(user_id) AND status = 'active')::int AS locked_savings,
  (SELECT count(*) FROM ajo_members m JOIN ajo_groups g ON g.id = m.group_id
     WHERE m.user_id = sqlc.arg(user_id) AND m.status IN ('invited', 'joined', 'defaulted') AND g.status IN ('forming', 'active'))::int AS ajo_groups,
  (SELECT count(*) FROM transfers WHERE transfers.user_id = sqlc.arg(user_id)
     AND status IN ('created', 'risk_checked', 'pending_step_up', 'delayed', 'held_for_review', 'processing'))::int AS transfers_in_flight,
  (SELECT count(*) FROM disputes WHERE disputes.user_id = sqlc.arg(user_id) AND status IN ('submitted', 'under_review', 'awaiting_customer'))::int AS open_disputes,
  (SELECT count(*) FROM dependants WHERE guardian_id = sqlc.arg(user_id))::int AS dependants,
  (SELECT count(*) FROM account_holds h JOIN customer_accounts a ON a.account_id = h.account_id
     WHERE a.user_id = sqlc.arg(user_id) AND h.status = 'active')::int AS active_holds;

-- ---------------------------------------------------------------- erasure

-- name: EraseUser :exec
-- The user row stays (the ledger and the audit log point at it) but identifies nobody. The
-- placeholder email cannot be a login (the domain is reserved) and frees the real one for reuse.
UPDATE users SET
  first_name = 'Deleted', last_name = 'Customer', preferred_name = NULL,
  email = 'deleted-' || id::text || '@erased.invalid',
  phone = '+23470' || lpad(nextval('erased_phone_seq')::text, 8, '0'),
  nemtag = NULL, nemtag_changed_at = NULL, date_of_birth = DATE '1900-01-01',
  password_hash = '!', pin_hash = NULL, duress_pin_hash = NULL, duress_since = NULL,
  pin_failures = 0, pin_lockouts = 0, pin_locked_until = NULL,
  kyc_tier = 1, kyc_status = 'not_started', deleted_at = sqlc.arg(now)::timestamptz
WHERE id = sqlc.arg(id);

-- name: EndSessions :exec
UPDATE sessions SET revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'session_revoked') WHERE user_id = sqlc.arg(user_id);

-- name: DeleteRefreshTokens :exec
DELETE FROM refresh_tokens WHERE session_id IN (SELECT id FROM sessions WHERE sessions.user_id = sqlc.arg(user_id));

-- name: EraseDevices :exec
UPDATE devices SET name = 'Deleted device', app_version = NULL, revoked_at = coalesce(revoked_at, now()) WHERE user_id = sqlc.arg(user_id);

-- name: DeletePushTokens :exec
DELETE FROM push_tokens WHERE push_tokens.user_id = sqlc.arg(user_id);

-- name: DeleteKycIdentifiers :exec
DELETE FROM kyc_identifiers WHERE kyc_identifiers.user_id = sqlc.arg(user_id);

-- name: DeleteKycChecks :exec
DELETE FROM kyc_identity_checks WHERE kyc_identity_checks.user_id = sqlc.arg(user_id);

-- name: DeleteKycBlobs :exec
DELETE FROM kyc_document_blobs WHERE document_id IN (SELECT id FROM kyc_documents WHERE kyc_documents.user_id = sqlc.arg(user_id));

-- name: DeleteKycDocuments :exec
DELETE FROM kyc_documents WHERE kyc_documents.user_id = sqlc.arg(user_id);

-- name: EraseKycSubmissions :exec
UPDATE kyc_submissions SET address = '{}'::jsonb, id_expiry_date = NULL, rejection_reason = NULL, document_ids = '{}' WHERE user_id = sqlc.arg(user_id);

-- name: DeleteNotifications :exec
DELETE FROM notifications WHERE notifications.user_id = sqlc.arg(user_id);

-- name: DeleteNotificationPreferences :exec
DELETE FROM notification_preferences WHERE notification_preferences.user_id = sqlc.arg(user_id);

-- name: DeleteAssistantMessages :exec
DELETE FROM assistant_messages WHERE assistant_messages.user_id = sqlc.arg(user_id);

-- name: DeletePreparedActions :exec
DELETE FROM prepared_actions WHERE prepared_actions.user_id = sqlc.arg(user_id);

-- name: DeleteAssistantConversations :exec
DELETE FROM assistant_conversations WHERE assistant_conversations.user_id = sqlc.arg(user_id);

-- name: EraseSupportMessages :exec
UPDATE support_messages SET body = '[erased]', attachment_ids = '{}' WHERE conversation_id IN (SELECT id FROM support_conversations WHERE support_conversations.user_id = sqlc.arg(user_id));

-- name: EraseSupportConversations :exec
UPDATE support_conversations SET subject = '[erased]' WHERE user_id = sqlc.arg(user_id);

-- name: EraseDisputes :exec
UPDATE disputes SET description = '[erased]', evidence_ids = '{}' WHERE user_id = sqlc.arg(user_id);

-- name: DeleteAttachments :exec
DELETE FROM attachments WHERE attachments.user_id = sqlc.arg(user_id);

-- name: DeleteBeneficiaries :exec
DELETE FROM beneficiaries WHERE beneficiaries.user_id = sqlc.arg(user_id);

-- name: DeleteScheduledTransfers :exec
DELETE FROM scheduled_transfers WHERE scheduled_transfers.user_id = sqlc.arg(user_id);

-- name: ClosePaymentLinks :exec
UPDATE payment_links SET status = 'inactive', title = 'Deleted link', note = NULL WHERE user_id = sqlc.arg(user_id);

-- name: CloseSavingsGoals :exec
UPDATE savings_goals SET name = 'Closed goal', emoji = '•', status = 'closed', closed_at = coalesce(closed_at, now()) WHERE user_id = sqlc.arg(user_id);

-- name: DeleteCategoryCorrections :exec
DELETE FROM category_corrections WHERE category_corrections.user_id = sqlc.arg(user_id);

-- name: DeleteStatements :exec
DELETE FROM statements WHERE statements.user_id = sqlc.arg(user_id);

-- name: DeleteFxAlerts :exec
DELETE FROM fx_alerts WHERE fx_alerts.user_id = sqlc.arg(user_id);

-- name: DeleteSelfLimits :exec
DELETE FROM self_limits WHERE self_limits.user_id = sqlc.arg(user_id);

-- name: DeleteStaffNotes :exec
DELETE FROM staff_notes WHERE staff_notes.user_id = sqlc.arg(user_id);

-- name: CloseAccounts :exec
UPDATE customer_accounts SET status = 'closed', nickname = NULL WHERE user_id = sqlc.arg(user_id);

-- name: RenameLedgerAccounts :exec
-- The ledger keeps its rows; the customer's name leaves the account labels.
UPDATE ledger_accounts SET name = 'Closed account' WHERE owner_id = sqlc.arg(user_id);

-- name: TerminateCards :exec
UPDATE cards SET status = 'terminated', terminated_at = coalesce(terminated_at, now()), name_on_card = 'DELETED CUSTOMER', nickname = NULL WHERE user_id = sqlc.arg(user_id);

-- name: RevokeAPIKeys :exec
UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = sqlc.arg(user_id);

-- name: DeleteWebhooks :exec
UPDATE webhook_endpoints SET deleted_at = coalesce(deleted_at, now()), description = NULL WHERE user_id = sqlc.arg(user_id);

-- name: ClearWebhookDeliveries :exec
UPDATE webhook_deliveries SET payload = '{}'::jsonb, status = CASE WHEN status IN ('pending', 'retrying') THEN 'failed' ELSE status END, next_retry_at = NULL
WHERE endpoint_id IN (SELECT id FROM webhook_endpoints WHERE webhook_endpoints.user_id = sqlc.arg(user_id));

-- name: DeleteOwnExports :exec
DELETE FROM privacy_exports WHERE privacy_exports.user_id = sqlc.arg(user_id);

-- name: ErasePeersTransfers :exec
-- Other customers' records of a payment to this customer no longer name them.
UPDATE transfers SET recipient = jsonb_build_object('name', 'Deleted customer')
WHERE destination_account_id IN (SELECT ca.account_id FROM customer_accounts ca WHERE ca.user_id = sqlc.arg(user_id)) AND transfers.user_id <> sqlc.arg(user_id);

-- name: ErasePeersTransactions :exec
UPDATE transactions SET counterparty = jsonb_build_object('name', 'Deleted customer')
WHERE transactions.user_id <> sqlc.arg(user_id)
  AND reference IN (SELECT tr.reference FROM transfers tr
                      WHERE tr.user_id = sqlc.arg(user_id)
                         OR tr.destination_account_id IN (SELECT ca.account_id FROM customer_accounts ca WHERE ca.user_id = sqlc.arg(user_id)));

-- ---------------------------------------------------------------- export sections
-- Each returns one JSON document. Column lists are explicit: hashes, keys, tokens and anything
-- encrypted never leave the database.

-- name: ExportProfile :one
SELECT to_jsonb(u)::jsonb AS data FROM (
  SELECT id, first_name, last_name, preferred_name, email, phone, date_of_birth, nemtag, kyc_tier, kyc_status, is_demo, is_dependant,
         terms_version, privacy_version, consent_accepted_at, created_at
  FROM users WHERE id = sqlc.arg(user_id)) u;

-- name: ExportAccounts :one
SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.opened_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT c.account_id AS id, c.account_number, c.currency, c.kind, c.status, c.nickname, c.opened_at,
         l.balance_minor, l.available_minor
  FROM customer_accounts c JOIN ledger_accounts l ON l.id = c.account_id WHERE c.user_id = sqlc.arg(user_id)) a;

-- name: ExportTransactions :one
SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at, t.id), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, account_id, currency, type, direction, status, amount_minor, fee_minor, narration, reference, category, counterparty, created_at
  FROM transactions WHERE transactions.user_id = sqlc.arg(user_id)) t;

-- name: ExportTransfers :one
SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.created_at, t.id), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, reference, status, rail, recipient, currency, amount_minor, fee_minor, narration, created_at
  FROM transfers WHERE transfers.user_id = sqlc.arg(user_id)) t;

-- name: ExportBeneficiaries :one
SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.created_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, kind, name, nickname, nemtag, bank_name, account_number, favourite, created_at FROM beneficiaries WHERE beneficiaries.user_id = sqlc.arg(user_id)) b;

-- name: ExportScheduled :one
SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.created_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, recipient, currency, amount_minor, narration, frequency, status, next_run_at, ends_on, created_at FROM scheduled_transfers WHERE scheduled_transfers.user_id = sqlc.arg(user_id)) s;

-- name: ExportPaymentLinks :one
SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, title, note, amount_mode, amount_minor, currency, status, payments_count, total_received_minor, created_at FROM payment_links WHERE payment_links.user_id = sqlc.arg(user_id)) p;

-- name: ExportCards :one
SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.created_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, currency, type, status, network, last4, expiry_month, expiry_year, name_on_card, nickname, online_enabled, international_enabled, created_at, terminated_at
  FROM cards WHERE cards.user_id = sqlc.arg(user_id)) c;

-- name: ExportSavings :one
SELECT jsonb_build_object(
  'goals', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.created_at), '[]'::jsonb) FROM (
      SELECT id, name, emoji, target_minor, target_date, status, interest_earned_minor, created_at, closed_at FROM savings_goals WHERE savings_goals.user_id = sqlc.arg(user_id)) g),
  'locked', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.created_at), '[]'::jsonb) FROM (
      SELECT id, principal_minor, term_days, rate_bps, start_date, maturity_date, status, paid_out_minor, created_at FROM locked_savings WHERE locked_savings.user_id = sqlc.arg(user_id)) l)
)::jsonb AS data;

-- name: ExportCredit :one
SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.disbursed_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, principal_minor, apr_bps, tenor_days, interest_minor, fee_minor, total_minor, status, disbursed_at, closed_at FROM loans WHERE loans.user_id = sqlc.arg(user_id)) l;

-- name: ExportAjo :one
SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.joined_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT group_id, position, status, contributions_paid, missed_contributions, joined_at FROM ajo_members WHERE ajo_members.user_id = sqlc.arg(user_id)) m;

-- name: ExportDevices :one
SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.bound_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT id, name, platform, hardware_backed, bound_at, last_seen_at, revoked_at FROM devices WHERE devices.user_id = sqlc.arg(user_id)) d;

-- name: ExportKyc :one
SELECT jsonb_build_object(
  'identifiers', (SELECT coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) FROM (SELECT kind, last4, created_at FROM kyc_identifiers WHERE kyc_identifiers.user_id = sqlc.arg(user_id)) i),
  'submissions', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.submitted_at), '[]'::jsonb) FROM (
      SELECT id, target_tier, status, id_type, submitted_at, reviewed_at FROM kyc_submissions WHERE kyc_submissions.user_id = sqlc.arg(user_id)) s)
)::jsonb AS data;

-- name: ExportNotifications :one
SELECT jsonb_build_object(
  'inbox', (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.created_at), '[]'::jsonb) FROM (
      SELECT id, category, title, body, read_at, created_at FROM notifications WHERE notifications.user_id = sqlc.arg(user_id)) n),
  'preferences', (SELECT categories FROM notification_preferences WHERE notification_preferences.user_id = sqlc.arg(user_id))
)::jsonb AS data;

-- name: ExportSupport :one
SELECT jsonb_build_object(
  'disputes', (SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.created_at), '[]'::jsonb) FROM (
      SELECT case_number, reason, description, status, resolution_note, refund_minor, created_at, resolved_at FROM disputes WHERE disputes.user_id = sqlc.arg(user_id)) d),
  'chats', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.created_at), '[]'::jsonb) FROM (
      SELECT s.id, s.subject, s.status, s.created_at,
             (SELECT coalesce(jsonb_agg(jsonb_build_object('sender', m.sender, 'body', m.body, 'at', m.created_at) ORDER BY m.created_at), '[]'::jsonb)
                FROM support_messages m WHERE m.conversation_id = s.id) AS messages
      FROM support_conversations s WHERE s.user_id = sqlc.arg(user_id)) c)
)::jsonb AS data;

-- name: ExportAssistant :one
SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.created_at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT conversation_id, role, blocks, created_at FROM assistant_messages WHERE assistant_messages.user_id = sqlc.arg(user_id)) m;

-- name: ExportDeveloper :one
SELECT jsonb_build_object(
  'api_keys', (SELECT coalesce(jsonb_agg(to_jsonb(k) ORDER BY k.created_at), '[]'::jsonb) FROM (
      SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE api_keys.user_id = sqlc.arg(user_id)) k),
  'webhook_endpoints', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at), '[]'::jsonb) FROM (
      SELECT id, url, description, events, status, created_at FROM webhook_endpoints WHERE webhook_endpoints.user_id = sqlc.arg(user_id) AND deleted_at IS NULL) e)
)::jsonb AS data;

-- name: ExportActivityLog :one
-- What the bank's audit log holds about this customer: when, who kind of actor, what. Staff
-- names and metadata stay out: they are about the bank's own people and processes.
SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.at), '[]'::jsonb)::jsonb AS data FROM (
  SELECT at, actor_type, action, resource_type FROM audit_log
  WHERE (actor_type = 'customer' AND actor_id = sqlc.arg(user_id)::text) OR (resource_type = 'customer' AND resource_id = sqlc.arg(user_id)::text)
  ORDER BY seq DESC LIMIT 1000) a;
