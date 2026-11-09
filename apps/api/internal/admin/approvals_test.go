package admin

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// desk is a harness with four signed-in staff, one per role, and a recording action.
type desk struct {
	*harness
	support, compliance, finance, admin context.Context
	applied                             []Approval
	failNext                            error
}

func newDesk(t *testing.T) *desk {
	t.Helper()
	d := &desk{harness: newHarness(t)}
	signIn := func(name, email string, r Role) context.Context {
		_, secret := d.member(t, name, email, r)
		return d.signIn(t, email, secret)
	}
	d.support = signIn("Chidi Eze", "chidi@nem.bank", RoleSupport)
	d.compliance = signIn("Aisha Bello", "aisha@nem.bank", RoleCompliance)
	d.finance = signIn("Tunde Okafor", "tunde@nem.bank", RoleFinance)
	d.admin = signIn("Ifeoma Adeyemi", "ifeoma@nem.bank", RoleAdmin)
	d.svc.RegisterAction(ActionCustomerUnfreeze, ActionHandler{
		Apply: func(_ context.Context, _ pgx.Tx, a Approval) (Effect, error) {
			if err := d.failNext; err != nil {
				d.failNext = nil
				return Effect{}, err
			}
			d.applied = append(d.applied, a)
			return Effect{AuditAction: "customer.unfreeze", ResourceType: "customer", ResourceID: a.After["user_id"].(string)}, nil //nolint:forcetypeassert // set by the test
		},
	})
	return d
}

func (d *desk) propose(maker context.Context, t *testing.T, action Action) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pgx.BeginFunc(t.Context(), d.svc.pool, func(tx pgx.Tx) error {
		var err error
		id, err = d.svc.Propose(maker, tx, Proposal{
			Action: action, Reason: "Customer verified by video call", Summary: "Unfreeze Tolu's account",
			Before: map[string]any{"frozen": true}, After: map[string]any{"user_id": "u-1", "frozen": false},
		})
		return err
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	return id
}

func TestAnApprovalNeedsADifferentStaffMemberAndAppliesOnce(t *testing.T) {
	t.Parallel()
	d := newDesk(t)
	id := d.propose(d.support, t, ActionCustomerUnfreeze)

	// Four eyes: the maker cannot approve their own request.
	_, err := d.svc.Approve(d.support, id)
	wantProblem(t, err, ErrSameStaff)

	// A failing change leaves the request pending, so nothing half-happens.
	d.failNext = problem.Conflict("The account was already unfrozen.")
	if _, err := d.svc.Approve(d.compliance, id); err == nil {
		t.Fatal("approve with a failing change succeeded")
	}
	if a, _ := d.svc.Get(d.compliance, id); a.Status != StatusPending || a.Checker != nil {
		t.Fatalf("after a failed apply: %+v", a)
	}

	a, err := d.svc.Approve(d.compliance, id)
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if a.Status != StatusApproved || a.Checker == nil || a.Checker.Name != "Aisha Bello" || a.Maker.Name != "Chidi Eze" || a.DecidedAt == nil {
		t.Fatalf("approved = %+v", a)
	}
	if len(d.applied) != 1 || d.applied[0].After["frozen"] != false {
		t.Fatalf("applied = %+v", d.applied)
	}

	// The same checker retrying gets the same answer, and the change is not applied twice.
	again, err := d.svc.Approve(d.compliance, id)
	if err != nil || again.Status != StatusApproved || len(d.applied) != 1 {
		t.Fatalf("replayed approve = %+v, %v (applied %d)", again, err, len(d.applied))
	}
	// Anyone else deciding now is a conflict.
	_, err = d.svc.Approve(d.finance, id)
	wantProblem(t, err, problem.Conflict(""))
	_, err = d.svc.Reject(d.admin, id, "Too late for this")
	wantProblem(t, err, problem.Conflict(""))

	for action, want := range map[string]int{"approval.request": 1, "approval.approve": 1, "customer.unfreeze": 1} {
		if n := d.count(t, "SELECT count(*) FROM audit_log WHERE action = $1", action); n != want {
			t.Errorf("%s audit rows = %d, want %d", action, n, want)
		}
	}
	if n := d.count(t, "SELECT count(*) FROM audit_log WHERE action = 'customer.unfreeze' AND actor_type = 'system' AND metadata->>'approval_id' = $1", id.String()); n != 1 {
		t.Error("the applied change is not logged as the system acting on the approval")
	}
}

func TestCheckerRolesAndRejections(t *testing.T) {
	t.Parallel()
	d := newDesk(t)
	// Support staff may raise requests but never approve them.
	id := d.propose(d.compliance, t, ActionCustomerUnfreeze)
	_, err := d.svc.Approve(d.support, id)
	wantProblem(t, err, ErrCheckerRole)

	// An action can narrow who checks it: ledger adjustments are for finance and admin.
	d.svc.RegisterAction(ActionLedgerAdjustment, ActionHandler{
		CheckerRoles: []Role{RoleFinance, RoleAdmin},
		Apply: func(context.Context, pgx.Tx, Approval) (Effect, error) {
			return Effect{AuditAction: "ledger.adjustment.post", ResourceType: "journal_entry", ResourceID: "e-1"}, nil
		},
	})
	adj := d.propose(d.admin, t, ActionLedgerAdjustment)
	_, err = d.svc.Approve(d.compliance, adj)
	wantProblem(t, err, ErrCheckerRole)
	if a, err := d.svc.Approve(d.finance, adj); err != nil || a.Status != StatusApproved {
		t.Fatalf("finance approve = %+v, %v", a, err)
	}

	// A rejection needs a reason, records it, and changes nothing.
	_, err = d.svc.Reject(d.finance, id, "no")
	wantProblem(t, err, ErrBadReason)
	r, err := d.svc.Reject(d.finance, id, "No video call on record")
	if err != nil || r.Status != StatusRejected || r.RejectionReason == nil || *r.RejectionReason != "No video call on record" {
		t.Fatalf("reject = %+v, %v", r, err)
	}
	_, err = d.svc.Approve(d.admin, id)
	wantProblem(t, err, problem.Conflict(""))
	if len(d.applied) != 0 {
		t.Fatalf("a rejected request was applied: %+v", d.applied)
	}

	// Unregistered actions cannot be proposed, so nothing waits on a handler that is missing.
	err = pgx.BeginFunc(t.Context(), d.svc.pool, func(tx pgx.Tx) error {
		_, err := d.svc.Propose(d.admin, tx, Proposal{Action: ActionDisputeRefund, Reason: "Refund the customer", Summary: "Refund"})
		return err
	})
	if !errors.Is(err, ErrUnknownAction) {
		t.Fatalf("propose unknown action: %v", err)
	}
}

func TestRequestsExpireAfter72HoursAndListInQueueOrder(t *testing.T) {
	t.Parallel()
	d := newDesk(t)
	first := d.propose(d.support, t, ActionCustomerUnfreeze)
	d.clock.Advance(time.Hour)
	second := d.propose(d.support, t, ActionCustomerUnfreeze)

	// Pending: oldest first, one per page.
	one := 1
	page, info, err := d.svc.List(d.admin, StatusPending, nil, &one)
	if err != nil || len(page) != 1 || page[0].ID != first || info.NextCursor == nil {
		t.Fatalf("page 1 = %+v %+v %v", page, info, err)
	}
	page, info, err = d.svc.List(d.admin, StatusPending, info.NextCursor, &one)
	if err != nil || len(page) != 1 || page[0].ID != second || info.NextCursor != nil {
		t.Fatalf("page 2 = %+v %+v %v", page, info, err)
	}

	d.clock.Advance(approvalTTL - time.Hour)
	_, err = d.svc.Approve(d.compliance, first)
	wantProblem(t, err, ErrApprovalExpired)
	if a, _ := d.svc.Get(d.admin, first); a.Status != StatusExpired || a.DecidedAt != nil {
		t.Fatalf("expired request = %+v", a)
	}
	if a, err := d.svc.Approve(d.compliance, second); err != nil || a.Status != StatusApproved {
		t.Fatalf("approve the one still in time = %+v, %v", a, err)
	}
	if page, _, _ := d.svc.List(d.admin, StatusExpired, nil, nil); len(page) != 1 || page[0].ID != first {
		t.Fatalf("expired list = %+v", page)
	}
	if page, _, _ := d.svc.List(d.admin, StatusApproved, nil, nil); len(page) != 1 || page[0].ID != second {
		t.Fatalf("approved list = %+v", page)
	}
}

func TestTheDatabaseRefusesSelfApprovalEvenIfTheServiceDidNot(t *testing.T) {
	t.Parallel()
	d := newDesk(t)
	id := d.propose(d.finance, t, ActionCustomerUnfreeze)
	_, err := d.svc.pool.Exec(t.Context(),
		"UPDATE approval_requests SET status = 'approved', checker_id = maker_id, decided_at = now() WHERE id = $1", id)
	if err == nil {
		t.Fatal("a request was approved by its own maker")
	}
	_, err = d.svc.pool.Exec(t.Context(), "UPDATE approval_requests SET status = 'approved' WHERE id = $1", id)
	if err == nil {
		t.Fatal("a request was approved with no checker")
	}
}
