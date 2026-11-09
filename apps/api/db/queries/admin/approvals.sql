-- name: InsertApproval :one
INSERT INTO approval_requests (id, action, maker_id, reason, summary, before, after, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING id;

-- name: ExpireApprovals :exec
-- A pending request past its deadline can no longer be approved.
UPDATE approval_requests SET status = 'expired'
WHERE status = 'pending' AND expires_at <= @now;

-- name: GetApprovalForUpdate :one
SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE;

-- name: DecideApproval :exec
UPDATE approval_requests
SET status = @status, checker_id = @checker_id, decided_at = @decided_at, rejection_reason = @rejection_reason
WHERE id = $1 AND status = 'pending';

-- name: GetApprovalView :one
SELECT a.*, m.name AS maker_name, c.name AS checker_name
FROM approval_requests a
JOIN staff m ON m.id = a.maker_id
LEFT JOIN staff c ON c.id = a.checker_id
WHERE a.id = $1;

-- name: ListPendingApprovals :many
-- Oldest first: the request that has waited longest is at the top.
SELECT a.*, m.name AS maker_name, c.name AS checker_name
FROM approval_requests a
JOIN staff m ON m.id = a.maker_id
LEFT JOIN staff c ON c.id = a.checker_id
WHERE a.status = 'pending'
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (a.created_at, a.id) > (@after_at::timestamptz, @after_id::uuid))
ORDER BY a.created_at, a.id
LIMIT @lim;

-- name: ListClosedApprovals :many
-- Latest decision (or expiry) first.
SELECT a.*, m.name AS maker_name, c.name AS checker_name
FROM approval_requests a
JOIN staff m ON m.id = a.maker_id
LEFT JOIN staff c ON c.id = a.checker_id
WHERE a.status = @status
  AND (@after_id::uuid = '00000000-0000-0000-0000-000000000000'
       OR (coalesce(a.decided_at, a.expires_at), a.id) < (@after_at::timestamptz, @after_id::uuid))
ORDER BY coalesce(a.decided_at, a.expires_at) DESC, a.id DESC
LIMIT @lim;
