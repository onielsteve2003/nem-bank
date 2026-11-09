package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin/admindb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// approvalTTL is how long a request waits for a checker before it expires (the console's
// mock uses the same 72 hours).
const approvalTTL = 72 * time.Hour

// Action is a kind of change that needs a second staff member (contract
// ApprovalRequest.action).
type Action string

// Maker-checker actions (ADM-10).
const (
	ActionCustomerUnfreeze Action = "customer_unfreeze"
	ActionLimitOverride    Action = "limit_override"
	ActionLedgerAdjustment Action = "ledger_adjustment"
	ActionConfigChange     Action = "config_change"
	ActionDisputeRefund    Action = "dispute_refund"
)

// Approval statuses (contract MakerCheckerStatus).
const (
	StatusPending  = "pending"
	StatusApproved = "approved"
	StatusRejected = "rejected"
	StatusExpired  = "expired"
)

// defaultCheckerRoles are the contract's x-roles for the approve operation.
var defaultCheckerRoles = []Role{RoleCompliance, RoleFinance, RoleAdmin}

// Effect names what an approved change did, for the audit log.
type Effect struct {
	AuditAction  string // "customer.unfreeze", "ledger.adjustment.post", ...
	ResourceType string
	ResourceID   string
}

// ActionHandler is how a domain plugs one action into maker-checker.
type ActionHandler struct {
	// CheckerRoles may approve the action. Empty means compliance, finance or admin. A
	// ledger adjustment, say, can narrow this to finance and admin.
	CheckerRoles []Role
	// Apply carries out the change inside the approval's own transaction: the change and
	// the "approved" status commit together or not at all. An error (a *problem.Error for
	// "the state moved on", for example) leaves the request pending.
	Apply func(ctx context.Context, tx pgx.Tx, a Approval) (Effect, error)
}

// RegisterAction plugs a domain's handler in. Call it while wiring the app, before serving.
func (s *Service) RegisterAction(a Action, h ActionHandler) {
	if h.Apply == nil {
		panic("admin: RegisterAction needs an Apply func")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.actions[a] = h
}

func (s *Service) handler(a Action) (ActionHandler, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	h, ok := s.actions[a]
	return h, ok
}

// StaffRef is a staff member as other records show them.
type StaffRef struct {
	ID   uuid.UUID
	Name string
}

// Approval is a maker-checker request.
type Approval struct {
	ID              uuid.UUID
	Action          Action
	Status          string
	Maker           StaffRef
	Checker         *StaffRef
	Reason, Summary string
	// Before and After are the diff the checker sees; After is what Apply carries out.
	Before, After   map[string]any
	RejectionReason *string
	CreatedAt       time.Time
	DecidedAt       *time.Time
	ExpiresAt       time.Time
}

// Proposal is the maker's side of a request.
type Proposal struct {
	Action        Action
	Reason        string
	Summary       string
	Before, After map[string]any
}

func validReason(r string) bool {
	n := utf8.RuneCountInString(r)
	return n >= 5 && n <= 500
}

func encodeJSON(m map[string]any) ([]byte, error) {
	if m == nil {
		return nil, nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("encode approval diff: %w", err)
	}
	return b, nil
}

// Propose records a request from the signed-in staff member, in tx, so a domain can save
// its own "waiting for approval" state in the same transaction. Nothing changes until a
// different staff member approves it.
func (s *Service) Propose(ctx context.Context, tx pgx.Tx, p Proposal) (uuid.UUID, error) {
	maker, err := principal(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	if _, ok := s.handler(p.Action); !ok {
		return uuid.Nil, ErrUnknownAction
	}
	if !validReason(p.Reason) {
		return uuid.Nil, ErrBadReason
	}
	if n := utf8.RuneCountInString(p.Summary); n < 1 || n > 200 {
		return uuid.Nil, errors.New("propose: summary must be 1 to 200 characters")
	}
	before, err := encodeJSON(p.Before)
	if err != nil {
		return uuid.Nil, err
	}
	after, err := encodeJSON(p.After)
	if err != nil {
		return uuid.Nil, err
	}
	id, err := newID()
	if err != nil {
		return uuid.Nil, err
	}
	now := s.now()
	if _, err := s.q.WithTx(tx).InsertApproval(ctx, admindb.InsertApprovalParams{
		ID: id, Action: string(p.Action), MakerID: maker.StaffID, Reason: p.Reason, Summary: p.Summary,
		Before: before, After: after, CreatedAt: now, ExpiresAt: now.Add(approvalTTL),
	}); err != nil {
		return uuid.Nil, fmt.Errorf("insert approval: %w", err)
	}
	if err := s.audit(ctx, tx, staffActor(maker.StaffID, maker.Name), "approval.request", "approval", id.String(),
		map[string]any{"approval_action": string(p.Action), "approval_id": id.String()}); err != nil {
		return uuid.Nil, err
	}
	return id, nil
}

// decide is the checker's half shared by Approve and Reject. It locks the request, so two
// checkers deciding at once are serialised and the second sees the first's decision.
func (s *Service) decide(ctx context.Context, id uuid.UUID, approve bool, rejection string) (Approval, error) {
	checker, err := principal(ctx)
	if err != nil {
		return Approval{}, err
	}
	now := s.now()
	if err := s.q.ExpireApprovals(ctx, now); err != nil {
		return Approval{}, fmt.Errorf("expire approvals: %w", err)
	}
	want := StatusRejected
	if approve {
		want = StatusApproved
	}
	err = s.inTx(ctx, func(tx pgx.Tx, q *admindb.Queries) error {
		row, err := q.GetApprovalForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrApprovalNotFound
		}
		if err != nil {
			return fmt.Errorf("load approval: %w", err)
		}
		if row.MakerID == checker.StaffID {
			return ErrSameStaff
		}
		switch {
		case row.Status == StatusPending && !now.Before(row.ExpiresAt), row.Status == StatusExpired:
			return ErrApprovalExpired
		case row.Status == want && row.CheckerID != nil && *row.CheckerID == checker.StaffID:
			// The same checker sending the same decision again (a retry after a lost
			// answer): return the decision instead of a conflict, and change nothing.
			return errReplay
		case row.Status != StatusPending:
			return problem.Conflict("This request was already " + row.Status + ".")
		}
		action := Action(row.Action)
		h, ok := s.handler(action)
		if !ok {
			return fmt.Errorf("approval %s: no handler registered for %s", id, action)
		}
		roles := h.CheckerRoles
		if len(roles) == 0 {
			roles = defaultCheckerRoles
		}
		if approve && !checker.HasAny(roles...) {
			return ErrCheckerRole
		}

		var effect Effect
		if approve {
			a, err := s.view(ctx, q, id)
			if err != nil {
				return err
			}
			if effect, err = h.Apply(ctx, tx, a); err != nil {
				return err
			}
		}
		params := admindb.DecideApprovalParams{ID: id, Status: want, CheckerID: &checker.StaffID, DecidedAt: &now}
		if !approve {
			params.RejectionReason = &rejection
		}
		if err := q.DecideApproval(ctx, params); err != nil {
			return fmt.Errorf("decide approval: %w", err)
		}
		meta := map[string]any{"approval_action": row.Action, "approval_id": id.String()}
		verb := "approval.reject"
		if approve {
			verb = "approval.approve"
		}
		if err := s.audit(ctx, tx, staffActor(checker.StaffID, checker.Name), verb, "approval", id.String(), meta); err != nil {
			return err
		}
		if approve {
			// Logged as the bank: the change is the system acting on two people's say-so.
			return s.audit(ctx, tx, audit.System(), effect.AuditAction, effect.ResourceType, effect.ResourceID,
				map[string]any{"approval_id": id.String()})
		}
		return nil
	})
	if err != nil && !errors.Is(err, errReplay) {
		return Approval{}, err
	}
	return s.view(ctx, s.q, id)
}

var errReplay = errors.New("same decision again")

// Approve is the checker's approval: the change is applied and the request closed in one
// transaction. The checker must be someone other than the maker and hold a role allowed
// to approve the action.
func (s *Service) Approve(ctx context.Context, id uuid.UUID) (Approval, error) {
	return s.decide(ctx, id, true, "")
}

// Reject closes the request with the checker's reason; nothing changes.
func (s *Service) Reject(ctx context.Context, id uuid.UUID, reason string) (Approval, error) {
	if !validReason(reason) {
		return Approval{}, ErrBadReason
	}
	return s.decide(ctx, id, false, reason)
}

// Get returns one request.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Approval, error) {
	if err := s.q.ExpireApprovals(ctx, s.now()); err != nil {
		return Approval{}, fmt.Errorf("expire approvals: %w", err)
	}
	return s.view(ctx, s.q, id)
}

// List returns one page of requests in a status: pending oldest first (the longest
// waiting at the top), the others latest first.
func (s *Service) List(ctx context.Context, status string, cursor *string, limit *int) ([]Approval, api.PageInfo, error) {
	cur, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	if err := s.q.ExpireApprovals(ctx, s.now()); err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("expire approvals: %w", err)
	}
	n := pagination.Limit(limit)
	var rows []admindb.GetApprovalViewRow
	if status == StatusPending {
		got, err := s.q.ListPendingApprovals(ctx, admindb.ListPendingApprovalsParams{AfterID: cur.ID, AfterAt: cur.Time, Lim: int32(n + 1)}) //nolint:gosec // n is at most pagination.MaxLimit
		if err != nil {
			return nil, api.PageInfo{}, fmt.Errorf("list approvals: %w", err)
		}
		for _, r := range got {
			rows = append(rows, admindb.GetApprovalViewRow(r))
		}
	} else {
		got, err := s.q.ListClosedApprovals(ctx, admindb.ListClosedApprovalsParams{Status: status, AfterID: cur.ID, AfterAt: cur.Time, Lim: int32(n + 1)}) //nolint:gosec // as above
		if err != nil {
			return nil, api.PageInfo{}, fmt.Errorf("list approvals: %w", err)
		}
		for _, r := range got {
			rows = append(rows, admindb.GetApprovalViewRow(r))
		}
	}
	page, info := pagination.Page(rows, n, func(r admindb.GetApprovalViewRow) pagination.Cursor {
		if status == StatusPending {
			return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
		}
		at := r.ExpiresAt
		if r.DecidedAt != nil {
			at = *r.DecidedAt
		}
		return pagination.Cursor{Time: at, ID: r.ID}
	})
	out := make([]Approval, len(page))
	for i, r := range page {
		if out[i], err = approvalOf(r); err != nil {
			return nil, api.PageInfo{}, err
		}
	}
	return out, info, nil
}

func (s *Service) view(ctx context.Context, q *admindb.Queries, id uuid.UUID) (Approval, error) {
	row, err := q.GetApprovalView(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrApprovalNotFound
	}
	if err != nil {
		return Approval{}, fmt.Errorf("load approval: %w", err)
	}
	return approvalOf(row)
}

func decodeJSON(b []byte) (map[string]any, error) {
	if b == nil {
		return nil, nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("decode approval diff: %w", err)
	}
	return m, nil
}

func approvalOf(r admindb.GetApprovalViewRow) (Approval, error) {
	before, err := decodeJSON(r.Before)
	if err != nil {
		return Approval{}, err
	}
	after, err := decodeJSON(r.After)
	if err != nil {
		return Approval{}, err
	}
	a := Approval{
		ID: r.ID, Action: Action(r.Action), Status: r.Status, Maker: StaffRef{ID: r.MakerID, Name: r.MakerName},
		Reason: r.Reason, Summary: r.Summary, Before: before, After: after, RejectionReason: r.RejectionReason,
		CreatedAt: r.CreatedAt, DecidedAt: r.DecidedAt, ExpiresAt: r.ExpiresAt,
	}
	if r.CheckerID != nil && r.CheckerName != nil {
		a.Checker = &StaffRef{ID: *r.CheckerID, Name: *r.CheckerName}
	}
	return a, nil
}
