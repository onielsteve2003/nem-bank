package console

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console/consoledb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support"
)

// registerActions plugs the five maker-checker actions into the approval framework. Each Apply
// runs inside the approval's own transaction: the change and the "approved" status commit
// together or not at all.
func (s *Service) registerActions() {
	s.admin.RegisterAction(admin.ActionCustomerUnfreeze, admin.ActionHandler{Apply: s.applyUnfreeze})
	s.admin.RegisterAction(admin.ActionLimitOverride, admin.ActionHandler{Apply: s.applyLimitOverride})
	// Money moves only with finance's say-so: compliance can propose an adjustment elsewhere
	// but cannot approve one.
	s.admin.RegisterAction(admin.ActionLedgerAdjustment, admin.ActionHandler{
		CheckerRoles: []admin.Role{admin.RoleFinance, admin.RoleAdmin}, Apply: s.applyAdjustment,
	})
	s.admin.RegisterAction(admin.ActionConfigChange, admin.ActionHandler{Apply: s.applyConfigChange})
	s.admin.RegisterAction(admin.ActionDisputeRefund, admin.ActionHandler{
		CheckerRoles: []admin.Role{admin.RoleCompliance, admin.RoleFinance, admin.RoleAdmin}, Apply: s.applyDisputeRefund,
	})
}

type customerRef struct {
	UserID uuid.UUID `json:"user_id"`
}

func (s *Service) applyUnfreeze(ctx context.Context, tx pgx.Tx, a admin.Approval) (admin.Effect, error) {
	in, err := decodeAfter[customerRef](a)
	if err != nil {
		return admin.Effect{}, err
	}
	q := s.q.WithTx(tx)
	u, err := q.LockCustomer(ctx, in.UserID)
	if err != nil {
		return admin.Effect{}, fmt.Errorf("lock customer: %w", err)
	}
	if u.FrozenAt == nil {
		return admin.Effect{}, errNotFrozen
	}
	if err := q.UnfreezeCustomer(ctx, in.UserID); err != nil {
		return admin.Effect{}, fmt.Errorf("unfreeze customer: %w", err)
	}
	if err := q.SetCustomerAccountsStatus(ctx, consoledb.SetCustomerAccountsStatusParams{UserID: in.UserID, FromStatus: "frozen", ToStatus: "active"}); err != nil {
		return admin.Effect{}, fmt.Errorf("reopen accounts: %w", err)
	}
	return admin.Effect{AuditAction: "customer.unfreeze", ResourceType: "customer", ResourceID: in.UserID.String()}, nil
}

func (s *Service) applyLimitOverride(ctx context.Context, tx pgx.Tx, a admin.Approval) (admin.Effect, error) {
	in, err := decodeAfter[struct {
		UserID     uuid.UUID `json:"user_id"`
		DailyMinor string    `json:"daily_minor"`
		ExpiresAt  time.Time `json:"expires_at"`
	}](a)
	if err != nil {
		return admin.Effect{}, err
	}
	amt, err := money.ParseMinor(in.DailyMinor, string(money.NGN))
	if err != nil {
		return admin.Effect{}, fmt.Errorf("override amount: %w", err)
	}
	if !in.ExpiresAt.After(s.now()) {
		return admin.Effect{}, errOverrideExpired
	}
	id, err := uuid.NewV7()
	if err != nil {
		return admin.Effect{}, fmt.Errorf("override id: %w", err)
	}
	if err := s.q.WithTx(tx).InsertLimitOverride(ctx, consoledb.InsertLimitOverrideParams{
		ID: id, UserID: in.UserID, DailyMinor: amt.Amount(), ExpiresAt: in.ExpiresAt, ApprovalID: a.ID,
	}); err != nil {
		return admin.Effect{}, fmt.Errorf("insert limit override: %w", err)
	}
	return admin.Effect{AuditAction: "customer.limit_override", ResourceType: "customer", ResourceID: in.UserID.String()}, nil
}

type disputeRefundAfter struct {
	DisputeID   uuid.UUID `json:"dispute_id"`
	AmountMinor string    `json:"amount_minor"`
	Currency    string    `json:"currency"`
	Note        string    `json:"note"`
}

func (s *Service) applyDisputeRefund(ctx context.Context, tx pgx.Tx, a admin.Approval) (admin.Effect, error) {
	in, err := decodeAfter[disputeRefundAfter](a)
	if err != nil {
		return admin.Effect{}, err
	}
	amt, err := money.ParseMinor(in.AmountMinor, in.Currency)
	if err != nil {
		return admin.Effect{}, fmt.Errorf("refund amount: %w", err)
	}
	id := a.Maker.ID.String()
	name := a.Maker.Name
	_, err = s.support.DecideIn(ctx, tx, support.Decision{
		DisputeID: in.DisputeID, Outcome: "refund", Note: in.Note, Refund: &amt,
		Reviewer: support.Reviewer{ID: a.Maker.ID, Actor: audit.Actor{Type: audit.ActorStaff, ID: &id, Name: &name}},
	})
	if err != nil {
		return admin.Effect{}, err
	}
	return admin.Effect{AuditAction: "dispute.refund_approved", ResourceType: "dispute", ResourceID: in.DisputeID.String()}, nil
}
