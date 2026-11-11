-- name: InsertAjoGroup :one
INSERT INTO ajo_groups (
  id, name, account_id, created_by_id, contribution_minor, frequency,
  member_count, rotation, start_date, grace_period_hours, status,
  current_cycle, total_cycles, invite_code, invite_expires_at, created_at
) VALUES (
  @id, @name, @account_id, @created_by_id, @contribution_minor, @frequency,
  @member_count, @rotation, @start_date, @grace_period_hours, @status,
  @current_cycle, @total_cycles, @invite_code, @invite_expires_at, @created_at
) RETURNING *;

-- name: GetAjoGroup :one
SELECT g.*, a.balance_minor AS pot_balance_minor
FROM ajo_groups g
JOIN ledger_accounts a ON a.id = g.account_id
WHERE g.id = @id;

-- name: LockAjoGroup :one
SELECT * FROM ajo_groups WHERE id = @id FOR UPDATE;

-- name: GetAjoGroupByInviteCode :one
SELECT g.*, a.balance_minor AS pot_balance_minor
FROM ajo_groups g
JOIN ledger_accounts a ON a.id = g.account_id
WHERE g.invite_code = @invite_code;

-- name: ListAjoGroupsForUser :many
SELECT DISTINCT g.*, a.balance_minor AS pot_balance_minor
FROM ajo_groups g
JOIN ledger_accounts a ON a.id = g.account_id
LEFT JOIN ajo_members m ON m.group_id = g.id
WHERE g.created_by_id = @user_id OR (m.user_id = @user_id AND m.status <> 'left')
ORDER BY g.created_at DESC;

-- name: CheckAjoDebt :one
SELECT EXISTS (
  SELECT 1 FROM ajo_members
  WHERE user_id = @user_id AND status = 'defaulted' AND has_received_payout = true
) AS has_debt;

-- name: InsertAjoMember :exec
INSERT INTO ajo_members (
  group_id, user_id, source_account_id, position, status,
  has_received_payout, contributions_paid, missed_contributions, joined_at
) VALUES (
  @group_id, @user_id, @source_account_id, @position, @status,
  @has_received_payout, @contributions_paid, @missed_contributions, @joined_at
);

-- name: ListAjoMembers :many
SELECT * FROM ajo_members WHERE group_id = @group_id ORDER BY position NULLS LAST, joined_at;

-- name: GetAjoMember :one
SELECT * FROM ajo_members WHERE group_id = @group_id AND user_id = @user_id;

-- name: DeleteAjoMember :exec
DELETE FROM ajo_members WHERE group_id = @group_id AND user_id = @user_id;

-- name: UpdateAjoMemberPosition :exec
UPDATE ajo_members SET position = @position WHERE group_id = @group_id AND user_id = @user_id;

-- name: UpdateAjoMemberStatus :exec
UPDATE ajo_members
SET status = @status, missed_contributions = @missed_contributions
WHERE group_id = @group_id AND user_id = @user_id;

-- name: UpdateAjoMemberPayoutReceived :exec
UPDATE ajo_members
SET has_received_payout = true
WHERE group_id = @group_id AND user_id = @user_id;

-- name: IncrementAjoMemberPaid :exec
UPDATE ajo_members
SET contributions_paid = contributions_paid + 1
WHERE group_id = @group_id AND user_id = @user_id;

-- name: InsertAjoCycle :exec
INSERT INTO ajo_cycles (
  id, group_id, cycle_number, due_at, payout_to_user_id,
  payout_amount_minor, payout_status, created_at
) VALUES (
  @id, @group_id, @cycle_number, @due_at, @payout_to_user_id,
  @payout_amount_minor, @payout_status, @created_at
);

-- name: ListAjoCycles :many
SELECT * FROM ajo_cycles WHERE group_id = @group_id ORDER BY cycle_number;

-- name: GetAjoCycle :one
SELECT * FROM ajo_cycles WHERE group_id = @group_id AND cycle_number = @cycle_number;

-- name: UpdateAjoCyclePayoutStatus :exec
UPDATE ajo_cycles SET payout_status = @payout_status WHERE id = @id;

-- name: InsertAjoContribution :exec
INSERT INTO ajo_contributions (cycle_id, user_id, status, attempts, paid_at, entry_id)
VALUES (@cycle_id, @user_id, @status, @attempts, @paid_at, @entry_id);

-- name: ListAjoContributionsForCycle :many
SELECT * FROM ajo_contributions WHERE cycle_id = @cycle_id;

-- name: ListAjoContributionsForGroup :many
SELECT c.*, cy.group_id, cy.cycle_number
FROM ajo_contributions c
JOIN ajo_cycles cy ON cy.id = c.cycle_id
WHERE cy.group_id = @group_id
ORDER BY cy.cycle_number;

-- name: UpdateAjoContribution :exec
UPDATE ajo_contributions
SET status = @status, attempts = @attempts, paid_at = @paid_at, entry_id = @entry_id
WHERE cycle_id = @cycle_id AND user_id = @user_id;

-- name: UpdateAjoGroupStatus :exec
UPDATE ajo_groups SET status = @status, started_at = COALESCE(started_at, @started_at), ended_at = @ended_at
WHERE id = @id;

-- name: UpdateAjoGroupCurrentCycle :exec
UPDATE ajo_groups SET current_cycle = @current_cycle WHERE id = @id;

-- name: ListActiveAjoGroups :many
SELECT g.*, a.balance_minor AS pot_balance_minor
FROM ajo_groups g
JOIN ledger_accounts a ON a.id = g.account_id
WHERE g.status = 'active';
