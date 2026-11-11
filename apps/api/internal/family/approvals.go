package family

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/family/familydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// Screen applies a parent's controls to a dependant's planned transfer (transfers.Family). It
// returns nil for anyone who is not a dependant. For a dependant it refuses a paused account, a
// transfer to another bank the parent has turned off, and a day's spending over their limit; and
// for a transfer above the approval threshold it sets the money aside, asks the parent and
// answers 403 parent_approval_required. Nothing is sent until the parent approves.
func (s *Service) Screen(ctx context.Context, c transfers.FamilyCheck) error {
	d, err := s.q.GetDependantByUser(ctx, c.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("load dependant: %w", err)
	}
	if d.Paused {
		return errPaused
	}
	if c.Interbank && !d.CanSendToBanks {
		return errBankTransfers
	}
	now := s.now().UTC()
	// What they have sent today counts, and so does what is waiting for approval: it is as good
	// as spent once the parent says yes.
	st, err := s.limits.StatusFor(ctx, s.pool, c.UserID, 1, noCoolOff)
	if err != nil {
		return err
	}
	waiting, err := s.q.SumPendingApprovals(ctx, familydb.SumPendingApprovalsParams{UserID: c.UserID, Now: now})
	if err != nil {
		return fmt.Errorf("sum pending approvals: %w", err)
	}
	amount := c.Amount.Amount()
	if left := max(d.DailySpendLimitMinor-st.UsedMinor-waiting, 0); amount > left {
		return problem.New(http.StatusUnprocessableEntity, limits.CodeLimitExceeded, "Above your daily spending limit").
			WithDetailf("Your parent set a limit of ₦%s a day. You can spend ₦%s more today.",
				accounts.FormatAmount(d.DailySpendLimitMinor), accounts.FormatAmount(left))
	}
	if amount <= d.ApprovalThresholdMinor {
		return nil
	}
	if c.NoApproval {
		return problem.New(http.StatusForbidden, "parent_approval_required", "This needs your parent's approval").
			WithDetailf("Transfers above ₦%s need approval, and a scheduled one cannot wait for it. Send it now instead.",
				accounts.FormatAmount(d.ApprovalThresholdMinor))
	}
	return s.requestApproval(ctx, d, c)
}

func (s *Service) requestApproval(ctx context.Context, d familydb.Dependant, c transfers.FamilyCheck) error {
	dest, err := json.Marshal(c.Request.Destination)
	if err != nil {
		return fmt.Errorf("destination: %w", err)
	}
	recipient, err := json.Marshal(c.Recipient)
	if err != nil {
		return fmt.Errorf("recipient: %w", err)
	}
	guardian, err := s.q.GetUserName(ctx, d.GuardianID)
	if err != nil {
		return fmt.Errorf("load guardian: %w", err)
	}
	asked := problem.New(http.StatusForbidden, "parent_approval_required", "Waiting for your parent").
		WithDetailf("We asked %s to approve this. You will see their answer under Approvals.", guardian.FirstName)

	now := s.now().UTC()
	// A retry of the same request finds the approval it already made.
	_, err = s.q.FindPendingApproval(ctx, familydb.FindPendingApprovalParams{
		UserID: c.UserID, AmountMinor: c.Amount.Amount(), Destination: dest, Narration: c.Request.Narration, Now: now,
	})
	if err == nil {
		return asked
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("find pending approval: %w", err)
	}
	name, err := s.q.GetUserName(ctx, c.UserID)
	if err != nil {
		return fmt.Errorf("load dependant name: %w", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("approval id: %w", err)
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		// The money, with the fee, is set aside now, so approving cannot fail for lack of funds
		// and the dependant cannot spend it twice meanwhile.
		hold, err := ledger.PlaceHold(ctx, tx, ledger.Hold{Account: c.Request.SourceAccountID, Amount: c.Total, Reference: id.String(), Reason: "pending_transfer"})
		if errors.Is(err, ledger.ErrInsufficientFunds) {
			return ledger.ErrInsufficientFunds.WithDetailf("You need ₦%s including the fee.", accounts.FormatAmount(c.Total.Amount()))
		}
		if err != nil {
			return fmt.Errorf("hold for approval: %w", err)
		}
		q := s.q.WithTx(tx)
		if _, err := q.InsertApproval(ctx, familydb.InsertApprovalParams{
			ID: id, DependantID: d.ID, GuardianID: d.GuardianID, UserID: c.UserID, SourceAccountID: c.Request.SourceAccountID,
			Destination: dest, Recipient: recipient, AmountMinor: c.Amount.Amount(), Narration: c.Request.Narration,
			Category: c.Request.Category, HoldID: &hold.ID, CreatedAt: now, ExpiresAt: now.Add(ApprovalTTL),
		}); err != nil {
			return fmt.Errorf("insert approval: %w", err)
		}
		return emit(ctx, tx, TopicApprovalRequested, "family_approval", id, map[string]any{
			"approval_id": id, "guardian_id": d.GuardianID, "user_id": c.UserID, "dependant_name": name.FirstName,
			"amount_minor": c.Amount.Amount(), "currency": string(money.NGN),
		})
	})
	if err != nil {
		return err
	}
	return asked
}

// Approvals lists the requests waiting for the caller (a parent sees their dependants', a
// dependant sees their own), pending first.
func (s *Service) Approvals(ctx context.Context, status *string) ([]api.FamilyApproval, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListApprovals(ctx, familydb.ListApprovalsParams{UserID: p.UserID, Status: status})
	if err != nil {
		return nil, fmt.Errorf("list approvals: %w", err)
	}
	out := make([]api.FamilyApproval, 0, len(rows))
	for _, r := range rows {
		a, err := approvalJSON(familydb.FamilyApproval{
			ID: r.ID, DependantID: r.DependantID, GuardianID: r.GuardianID, UserID: r.UserID, SourceAccountID: r.SourceAccountID,
			Destination: r.Destination, Recipient: r.Recipient, AmountMinor: r.AmountMinor, Narration: r.Narration, Category: r.Category,
			Status: r.Status, HoldID: r.HoldID, TransferID: r.TransferID, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, DecidedAt: r.DecidedAt,
		}, r.FirstName+" "+r.LastName, r.Nemtag)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

func approvalJSON(a familydb.FamilyApproval, name string, nemtag *string) (api.FamilyApproval, error) {
	var party api.TransferParty
	if err := json.Unmarshal(a.Recipient, &party); err != nil {
		return api.FamilyApproval{}, fmt.Errorf("approval recipient: %w", err)
	}
	return api.FamilyApproval{
		Id: a.ID, Dependant: api.PartySummary{Name: name, Nemtag: nemtag, UserId: a.UserID}, Recipient: party,
		Amount: accounts.Money(money.New(a.AmountMinor, money.NGN)), Narration: a.Narration, Status: api.ApprovalStatus(a.Status),
		TransferId: a.TransferID, CreatedAt: a.CreatedAt.UTC(), ExpiresAt: a.ExpiresAt.UTC(),
	}, nil
}

func (s *Service) approvalView(ctx context.Context, a familydb.FamilyApproval) (api.FamilyApproval, error) {
	n, err := s.q.GetUserName(ctx, a.UserID)
	if err != nil {
		return api.FamilyApproval{}, fmt.Errorf("load dependant name: %w", err)
	}
	return approvalJSON(a, n.FirstName+" "+n.LastName, n.Nemtag)
}

// release gives back the money set aside for a request. A hold that is already closed is not an
// error: the money is back either way.
func release(ctx context.Context, tx pgx.Tx, a familydb.FamilyApproval) error {
	if a.HoldID == nil {
		return nil
	}
	if err := ledger.ReleaseHold(ctx, tx, *a.HoldID); err != nil && !errors.Is(err, ledger.ErrHoldClosed) {
		return fmt.Errorf("release approval hold: %w", err)
	}
	return nil
}

func decided(ctx context.Context, tx pgx.Tx, a familydb.FamilyApproval, name string) error {
	return emit(ctx, tx, TopicApprovalDecided, "family_approval", a.ID, map[string]any{
		"approval_id": a.ID, "guardian_id": a.GuardianID, "user_id": a.UserID, "dependant_name": name,
		"status": a.Status, "amount_minor": a.AmountMinor, "currency": string(money.NGN),
	})
}

// Approve lets a dependant's transfer go: the money set aside is released and the transfer is
// sent as the dependant, in one transaction. If the bank refuses it (a limit, say) the request
// stays open and the parent sees why.
func (s *Service) Approve(ctx context.Context, id uuid.UUID) (api.FamilyApproval, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.FamilyApproval{}, err
	}
	a, err := s.q.GetApprovalAny(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && a.GuardianID != p.UserID) {
		return api.FamilyApproval{}, errApprovalNotFound
	}
	if err != nil {
		return api.FamilyApproval{}, fmt.Errorf("load approval: %w", err)
	}
	if a.Status != "pending" || !s.now().Before(a.ExpiresAt) {
		return api.FamilyApproval{}, errNotOpen
	}
	var dest api.TransferDestination
	if err := json.Unmarshal(a.Destination, &dest); err != nil {
		return api.FamilyApproval{}, fmt.Errorf("approval destination: %w", err)
	}
	name, err := s.q.GetUserName(ctx, a.UserID)
	if err != nil {
		return api.FamilyApproval{}, fmt.Errorf("load dependant name: %w", err)
	}
	var done familydb.FamilyApproval
	_, err = s.sender.SendAs(ctx, a.UserID, transfers.Request{
		SourceAccountID: a.SourceAccountID, Destination: dest, Amount: money.New(a.AmountMinor, money.NGN),
		Narration: a.Narration, Category: a.Category,
	}, transfers.Hooks{
		Before: func(ctx context.Context, tx pgx.Tx) error {
			// Judged again under the lock: a second tap or the expiry clock may have got here first.
			locked, err := s.q.WithTx(tx).GetApprovalForUpdate(ctx, familydb.GetApprovalForUpdateParams{ID: id, GuardianID: p.UserID})
			if err != nil {
				return fmt.Errorf("lock approval: %w", err)
			}
			if locked.Status != "pending" || !s.now().Before(locked.ExpiresAt) {
				return errNotOpen
			}
			return release(ctx, tx, locked)
		},
		After: func(ctx context.Context, tx pgx.Tx, transferID uuid.UUID) error {
			now := s.now().UTC()
			var err error
			if done, err = s.q.WithTx(tx).DecideApproval(ctx, familydb.DecideApprovalParams{ID: id, Status: "approved", At: &now, TransferID: &transferID}); err != nil {
				return fmt.Errorf("decide approval: %w", err)
			}
			return decided(ctx, tx, done, name.FirstName)
		},
	})
	if err != nil {
		return api.FamilyApproval{}, err
	}
	return s.approvalView(ctx, done)
}

// Decline refuses a dependant's transfer and gives the money back.
func (s *Service) Decline(ctx context.Context, id uuid.UUID) (api.FamilyApproval, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.FamilyApproval{}, err
	}
	return s.close(ctx, id, &p.UserID, "declined")
}

// close ends a pending request as declined or expired. guardian is the parent answering, or nil
// for the clock.
func (s *Service) close(ctx context.Context, id uuid.UUID, guardian *uuid.UUID, status string) (api.FamilyApproval, error) {
	var done familydb.FamilyApproval
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		var owner uuid.UUID
		if guardian != nil {
			owner = *guardian
		} else {
			a, err := q.GetApprovalAny(ctx, id)
			if errors.Is(err, pgx.ErrNoRows) {
				return errApprovalNotFound
			}
			if err != nil {
				return fmt.Errorf("load approval: %w", err)
			}
			owner = a.GuardianID
		}
		locked, err := q.GetApprovalForUpdate(ctx, familydb.GetApprovalForUpdateParams{ID: id, GuardianID: owner})
		if errors.Is(err, pgx.ErrNoRows) {
			return errApprovalNotFound
		}
		if err != nil {
			return fmt.Errorf("lock approval: %w", err)
		}
		if locked.Status != "pending" {
			return errNotOpen
		}
		if err := release(ctx, tx, locked); err != nil {
			return err
		}
		now := s.now().UTC()
		if done, err = q.DecideApproval(ctx, familydb.DecideApprovalParams{ID: id, Status: status, At: &now}); err != nil {
			return fmt.Errorf("decide approval: %w", err)
		}
		n, err := q.GetUserName(ctx, done.UserID)
		if err != nil {
			return fmt.Errorf("load dependant name: %w", err)
		}
		return decided(ctx, tx, done, n.FirstName)
	})
	if err != nil {
		return api.FamilyApproval{}, err
	}
	return s.approvalView(ctx, done)
}

// ExpireDue lapses the requests nobody answered in time and gives their money back. One
// request's failure never stops the others.
func (s *Service) ExpireDue(ctx context.Context) error {
	due, err := s.q.ListExpiredApprovals(ctx, familydb.ListExpiredApprovalsParams{Now: s.now().UTC(), Lim: runBatch})
	if err != nil {
		return fmt.Errorf("list expired approvals: %w", err)
	}
	var errs []error
	for _, d := range due {
		if _, err := s.close(ctx, d.ID, nil, "expired"); err != nil && !errors.Is(err, errNotOpen) {
			s.log.ErrorContext(ctx, "expire approval failed", "approval_id", d.ID.String(), "error", err)
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
