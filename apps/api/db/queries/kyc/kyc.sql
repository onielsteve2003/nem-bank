-- name: LockUserKyc :one
-- The customer's KYC state and the facts a check compares against, locked for the change.
SELECT id, first_name, last_name, date_of_birth, kyc_tier, kyc_status FROM users WHERE id = @user_id FOR UPDATE;

-- name: GetUserKyc :one
SELECT id, first_name, last_name, date_of_birth, kyc_tier, kyc_status FROM users WHERE id = @user_id;

-- name: SetUserKyc :exec
UPDATE users SET kyc_tier = @tier, kyc_status = @status WHERE id = @user_id;

-- name: InsertDocument :exec
INSERT INTO kyc_documents (id, user_id, kind, status, quality_issues, content_type, size_bytes, sha256, sample, created_at)
VALUES (@id, @user_id, @kind, @status, @quality_issues, @content_type, @size_bytes, @sha256, @sample, @created_at);

-- name: InsertDocumentBlob :exec
INSERT INTO kyc_document_blobs (document_id, ciphertext) VALUES (@document_id, @ciphertext);

-- name: GetDocument :one
SELECT * FROM kyc_documents WHERE id = @id AND user_id = @user_id;

-- name: GetDocumentAny :one
-- For staff, who review any customer's documents.
SELECT * FROM kyc_documents WHERE id = @id;

-- name: GetDocumentBlob :one
SELECT ciphertext FROM kyc_document_blobs WHERE document_id = @document_id;

-- name: ListDocumentsByIDs :many
SELECT * FROM kyc_documents WHERE id = ANY(@ids::uuid[]) ORDER BY created_at, id;

-- name: CountUploadsSince :one
SELECT count(*) FROM kyc_documents WHERE user_id = @user_id AND created_at >= @since;

-- name: InsertIdentityCheck :exec
INSERT INTO kyc_identity_checks (id, user_id, kind, verified, name_result, name_confidence, dob_match, provider, created_at)
VALUES (@id, @user_id, @kind, @verified, @name_result, @name_confidence, @dob_match, @provider, @created_at);

-- name: CountFailedChecksSince :one
SELECT count(*) FROM kyc_identity_checks WHERE user_id = @user_id AND NOT verified AND created_at >= @since;

-- name: ListIdentityChecks :many
SELECT * FROM kyc_identity_checks WHERE user_id = @user_id ORDER BY created_at DESC, id DESC LIMIT 10;

-- name: InsertSubmission :one
INSERT INTO kyc_submissions (id, user_id, target_tier, status, id_type, id_expiry_date, address, document_ids, submitted_at)
VALUES (@id, @user_id, 3, 'pending_review', @id_type, @id_expiry_date, @address, @document_ids, @submitted_at)
RETURNING *;

-- name: GetSubmission :one
SELECT * FROM kyc_submissions WHERE id = @id AND user_id = @user_id;

-- name: LatestSubmission :one
SELECT * FROM kyc_submissions WHERE user_id = @user_id ORDER BY submitted_at DESC, id DESC LIMIT 1;

-- name: GetSubmissionAny :one
SELECT * FROM kyc_submissions WHERE id = @id;

-- name: LockSubmission :one
SELECT * FROM kyc_submissions WHERE id = @id FOR UPDATE;

-- name: ListSubmissions :many
-- The review queue, oldest first so nobody waits longer than they must. The first page passes
-- the zero time and the nil UUID.
SELECT * FROM kyc_submissions
WHERE status = @status AND (submitted_at, id) > (@after_time::timestamptz, @after_id::uuid)
ORDER BY submitted_at, id
LIMIT @page_size;

-- name: DecideSubmission :one
UPDATE kyc_submissions
SET status = @status, reviewed_at = @reviewed_at, reviewer_id = @reviewer_id,
    rejection_reason = @rejection_reason, resubmit_documents = @resubmit_documents
WHERE id = @id
RETURNING *;
