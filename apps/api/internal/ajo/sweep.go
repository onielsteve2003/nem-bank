package ajo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ajo/ajodb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// SweepArgs is the River job args for the ajo clock.
type SweepArgs struct{}

// Kind implements river.JobArgs.
func (SweepArgs) Kind() string { return "ajo_sweep" }

type sweepWorker struct {
	river.WorkerDefaults[SweepArgs]
	s *Service
}

func (w *sweepWorker) Work(ctx context.Context, _ *river.Job[SweepArgs]) error {
	return w.s.Sweep(ctx)
}

// Register registers the ajo sweep worker with River.
func (s *Service) Register(w *river.Workers) {
	river.AddWorker(w, &sweepWorker{s: s})
}

// PeriodicJobs returns periodic jobs for the ajo domain.
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(5*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return SweepArgs{}, &river.InsertOpts{MaxAttempts: 3} },
			&river.PeriodicJobOpts{RunOnStart: true}),
	}
}

// Sweep runs one check over all active ajo groups.
func (s *Service) Sweep(ctx context.Context) error {
	now := s.now().UTC()
	groups, err := s.q.ListActiveAjoGroups(ctx)
	if err != nil {
		return fmt.Errorf("list active ajo groups: %w", err)
	}

	var errs []error
	for _, g := range groups {
		if err := s.sweepGroup(ctx, g, now); err != nil {
			s.log.Warn("ajo group sweep", slog.String("group_id", g.ID.String()), slog.Any("error", err))
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Service) sweepGroup(ctx context.Context, g ajodb.ListActiveAjoGroupsRow, now time.Time) error {
	if g.CurrentCycle <= 0 || g.CurrentCycle > g.TotalCycles {
		return nil
	}

	cycle, err := s.q.GetAjoCycle(ctx, ajodb.GetAjoCycleParams{GroupID: g.ID, CycleNumber: g.CurrentCycle})
	if err != nil {
		return err
	}

	// 1. Collect unpaid contributions
	s.collectCycle(ctx, g.ID, int(cycle.CycleNumber))

	// 2. Check if cycle is due or all collected
	contribs, err := s.q.ListAjoContributionsForCycle(ctx, cycle.ID)
	if err != nil {
		return err
	}
	allPaid := true
	for _, c := range contribs {
		if c.Status != "paid" {
			allPaid = false
			break
		}
	}

	// If all contributions are in, or due time has passed, payout
	if allPaid || !now.Before(cycle.DueAt) {
		if cycle.PayoutStatus == "collecting" || cycle.PayoutStatus == "upcoming" {
			s.payoutCycle(ctx, g.ID, int(cycle.CycleNumber))
		}
	}

	// 3. Settle grace period / defaults
	s.settleLate(ctx, g.ID, now)
	return nil
}

func (s *Service) collectCycle(ctx context.Context, groupID uuid.UUID, cycleNumber int) {
	cycle, err := s.q.GetAjoCycle(ctx, ajodb.GetAjoCycleParams{GroupID: groupID, CycleNumber: int32(cycleNumber)}) //nolint:gosec // a cycle number is at most the group size (30)
	if err != nil {
		return
	}
	g, err := s.q.GetAjoGroup(ctx, groupID)
	if err != nil {
		return
	}
	contribs, err := s.q.ListAjoContributionsForCycle(ctx, cycle.ID)
	if err != nil {
		return
	}
	members, err := s.q.ListAjoMembers(ctx, groupID)
	if err != nil {
		return
	}
	memberAccounts := make(map[uuid.UUID]uuid.UUID)
	for _, m := range members {
		memberAccounts[m.UserID] = m.SourceAccountID
	}

	amt := money.New(g.ContributionMinor, money.NGN)

	for _, c := range contribs {
		if c.Status == "paid" {
			continue
		}
		sourceAccID, ok := memberAccounts[c.UserID]
		if !ok {
			continue
		}
		attempts := c.Attempts + 1
		lineID, err := uuid.NewV7()
		if err != nil {
			continue
		}
		now := s.now().UTC()

		err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
			ref := reference("AJO", lineID)
			posted, err := ledger.Post(ctx, tx, ledger.Entry{
				Kind:           "ajo_contribution",
				Reference:      ref,
				IdempotencyKey: fmt.Sprintf("ajo:%s:%d:%s:%d", groupID, cycleNumber, c.UserID, attempts),
				Metadata:       map[string]any{"group_id": groupID.String(), "cycle": cycleNumber, "user_id": c.UserID.String()},
				Legs: []ledger.Leg{
					ledger.Debit(sourceAccID, amt),
					ledger.Credit(g.AccountID, amt),
				},
			})
			if err != nil {
				return err
			}
			l := accounts.Line{
				ID: lineID, UserID: c.UserID, AccountID: sourceAccID, Type: "ajo", Direction: "debit",
				Status: "completed", Amount: amt, Entry: &posted, Narration: g.Name + " contribution",
				Reference: ref, Category: "savings", At: now,
				Counterparty: api.Counterparty{Name: g.Name},
			}
			if _, err := accounts.Record(ctx, tx, l); err != nil {
				return err
			}
			q := s.q.WithTx(tx)
			if err := q.UpdateAjoContribution(ctx, ajodb.UpdateAjoContributionParams{
				CycleID:  cycle.ID,
				UserID:   c.UserID,
				Status:   "paid",
				Attempts: attempts,
				PaidAt:   &now,
				EntryID:  &posted.EntryID,
			}); err != nil {
				return err
			}
			return q.IncrementAjoMemberPaid(ctx, ajodb.IncrementAjoMemberPaidParams{
				GroupID: groupID,
				UserID:  c.UserID,
			})
		})

		if err != nil {
			// Mark late
			_ = s.q.UpdateAjoContribution(ctx, ajodb.UpdateAjoContributionParams{
				CycleID:  cycle.ID,
				UserID:   c.UserID,
				Status:   "late",
				Attempts: attempts,
				PaidAt:   nil,
				EntryID:  nil,
			})
		}
	}
}

func (s *Service) payoutCycle(ctx context.Context, groupID uuid.UUID, cycleNumber int) {
	g, err := s.q.GetAjoGroup(ctx, groupID)
	if err != nil {
		return
	}
	cycle, err := s.q.GetAjoCycle(ctx, ajodb.GetAjoCycleParams{GroupID: groupID, CycleNumber: int32(cycleNumber)}) //nolint:gosec // a cycle number is at most the group size (30)
	if err != nil {
		return
	}
	if cycle.PayoutStatus == "paid" {
		return
	}

	pot := g.PotBalanceMinor
	if pot <= 0 {
		return
	}

	payeeNairaAcc, err := s.accounts.Naira(ctx, cycle.PayoutToUserID)
	if err != nil {
		return
	}

	lineID, err := uuid.NewV7()
	if err != nil {
		return
	}
	now := s.now().UTC()
	potMoney := money.New(pot, money.NGN)

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		ref := reference("AJO", lineID)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind:           "ajo_payout",
			Reference:      ref,
			IdempotencyKey: fmt.Sprintf("ajo-payout:%s:%d", groupID, cycleNumber),
			Metadata:       map[string]any{"group_id": groupID.String(), "cycle": cycleNumber, "payee_id": cycle.PayoutToUserID.String()},
			Legs: []ledger.Leg{
				ledger.Debit(g.AccountID, potMoney),
				ledger.Credit(payeeNairaAcc.AccountID, potMoney),
			},
		})
		if err != nil {
			return err
		}
		l := accounts.Line{
			ID: lineID, UserID: cycle.PayoutToUserID, AccountID: payeeNairaAcc.AccountID, Type: "ajo", Direction: "credit",
			Status: "completed", Amount: potMoney, Entry: &posted, Narration: g.Name + " payout",
			Reference: ref, Category: "savings", At: now,
			Counterparty: api.Counterparty{Name: g.Name},
		}
		if _, err := accounts.Record(ctx, tx, l); err != nil {
			return err
		}

		pStatus := "paid"
		if pot < cycle.PayoutAmountMinor {
			pStatus = "short_paid"
		}
		q := s.q.WithTx(tx)
		if err := q.UpdateAjoCyclePayoutStatus(ctx, ajodb.UpdateAjoCyclePayoutStatusParams{
			ID:           cycle.ID,
			PayoutStatus: pStatus,
		}); err != nil {
			return err
		}
		if err := q.UpdateAjoMemberPayoutReceived(ctx, ajodb.UpdateAjoMemberPayoutReceivedParams{
			GroupID: groupID,
			UserID:  cycle.PayoutToUserID,
		}); err != nil {
			return err
		}

		nextCycle := int(cycle.CycleNumber) + 1
		if nextCycle > int(g.TotalCycles) {
			endedAt := now
			return q.UpdateAjoGroupStatus(ctx, ajodb.UpdateAjoGroupStatusParams{
				ID:        groupID,
				Status:    "completed",
				StartedAt: g.StartedAt,
				EndedAt:   &endedAt,
			})
		}
		if err := q.UpdateAjoGroupCurrentCycle(ctx, ajodb.UpdateAjoGroupCurrentCycleParams{
			ID:           groupID,
			CurrentCycle: int32(nextCycle), //nolint:gosec // at most the group size (30)
		}); err != nil {
			return err
		}
		nextRow, err := q.GetAjoCycle(ctx, ajodb.GetAjoCycleParams{GroupID: groupID, CycleNumber: int32(nextCycle)}) //nolint:gosec // at most the group size (30)
		if err == nil {
			_ = q.UpdateAjoCyclePayoutStatus(ctx, ajodb.UpdateAjoCyclePayoutStatusParams{
				ID:           nextRow.ID,
				PayoutStatus: "collecting",
			})
		}
		return nil
	})
	if err != nil {
		s.log.Error("ajo payout failed", slog.String("group_id", groupID.String()), slog.Any("error", err))
	}
}

func (s *Service) settleLate(ctx context.Context, groupID uuid.UUID, now time.Time) {
	g, err := s.q.GetAjoGroup(ctx, groupID)
	if err != nil {
		return
	}
	cycles, err := s.q.ListAjoCycles(ctx, groupID)
	if err != nil {
		return
	}
	graceDuration := time.Duration(g.GracePeriodHours) * time.Hour

	for _, c := range cycles {
		if c.CycleNumber >= g.CurrentCycle {
			continue
		}
		contribs, err := s.q.ListAjoContributionsForCycle(ctx, c.ID)
		if err != nil {
			continue
		}
		graceEnds := c.DueAt.Add(graceDuration)
		if graceEnds.After(now) {
			continue
		}

		for _, contrib := range contribs {
			if contrib.Status == "late" {
				_ = s.q.UpdateAjoContribution(ctx, ajodb.UpdateAjoContributionParams{
					CycleID:  c.ID,
					UserID:   contrib.UserID,
					Status:   "defaulted",
					Attempts: contrib.Attempts,
					PaidAt:   nil,
					EntryID:  nil,
				})
				m, err := s.q.GetAjoMember(ctx, ajodb.GetAjoMemberParams{GroupID: groupID, UserID: contrib.UserID})
				if err == nil {
					_ = s.q.UpdateAjoMemberStatus(ctx, ajodb.UpdateAjoMemberStatusParams{
						GroupID:             groupID,
						UserID:              contrib.UserID,
						Status:              "defaulted",
						MissedContributions: m.MissedContributions + 1,
					})
				}
			}
		}
	}
}

// AdvanceUser runs the ajo clock for the groups a demo customer started, as of asOf, a day the
// demo clock has moved to: contributions are collected, due cycles pay out and late members are
// settled, cycle after cycle, as the sweep would have done on those days. Groups other people
// started keep their own time.
func (s *Service) AdvanceUser(ctx context.Context, userID uuid.UUID, asOf time.Time) error {
	rows, err := s.pool.Query(ctx, `SELECT id FROM ajo_groups WHERE created_by_id = $1 AND status = 'active'`, userID)
	if err != nil {
		return fmt.Errorf("list groups: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return fmt.Errorf("read groups: %w", err)
	}
	now := asOf.UTC()
	for _, id := range ids {
		// One pass per cycle at most: a pass that moves nothing ends the loop.
		for range 31 {
			groups, err := s.q.ListActiveAjoGroups(ctx)
			if err != nil {
				return fmt.Errorf("list active ajo groups: %w", err)
			}
			i := slices.IndexFunc(groups, func(g ajodb.ListActiveAjoGroupsRow) bool { return g.ID == id })
			if i < 0 {
				break
			}
			before := groups[i].CurrentCycle
			if err := s.sweepGroup(ctx, groups[i], now); err != nil {
				return err
			}
			after, err := s.q.GetAjoGroup(ctx, id)
			if err != nil || after.Status != "active" || after.CurrentCycle == before {
				break
			}
		}
	}
	return nil
}
