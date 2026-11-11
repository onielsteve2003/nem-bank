package transfers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// Reconciliation item statuses (contract ReconciliationItemStatus).
const (
	ReconMissingInLedger  = "missing_in_ledger"
	ReconMissingAtPartner = "missing_at_partner"
	ReconAmountMismatch   = "amount_mismatch"
)

// lagos is West Africa Time (no daylight saving): reconciliation days are Lagos days.
var lagos = time.FixedZone("WAT", 60*60)

// ReconItem is one payment the partner and the ledger disagree on. A nil amount means that
// side has no such payment (or, for a transfer the saga reversed, did not pay it out).
type ReconItem struct {
	Reference string
	Status    string
	Partner   *money.Money
	Ledger    *money.Money
}

// Reconciliation is one Lagos day's partner settlement file set against the ledger.
type Reconciliation struct {
	Date        time.Time
	Partner     string
	GeneratedAt time.Time
	Matched     int
	// Items are the unmatched payments only, ordered by reference.
	Items []ReconItem
}

var errNoSettlementFile = problem.NotFound("Settlement file").
	WithDetail("The configured bank partner does not publish a settlement file.")

// Reconcile sets the partner's settlement file for the Lagos calendar day containing date
// against the transfers the ledger completed that day. Every payment is matched by Nem's
// reference (the partner's idempotency key). It only reads, so finance can run it as often
// as they like.
//
// Three ways a payment can disagree, none of which the saga can repair by itself:
//   - missing_in_ledger: the partner settled it but no completed transfer matches. The
//     worst case is a transfer the saga already reversed: the customer got the money back
//     and the partner paid out anyway.
//   - missing_at_partner: the ledger paid it out but the partner never settled it.
//   - amount_mismatch: both settled it, for different amounts.
func (s *Service) Reconcile(ctx context.Context, date time.Time) (Reconciliation, error) {
	reporter, ok := s.partner.(partners.SettlementReporter)
	if !ok {
		return Reconciliation{}, errNoSettlementFile
	}
	y, m, d := date.Date()
	from := time.Date(y, m, d, 0, 0, 0, 0, lagos)
	to := from.AddDate(0, 0, 1)
	if from.After(s.now()) {
		return Reconciliation{}, problem.New(422, problem.CodeValidationFailed, "That day has not happened yet")
	}

	file, err := reporter.SettlementReport(ctx, from, to)
	if err != nil {
		return Reconciliation{}, fmt.Errorf("settlement report: %w", err)
	}
	paid, err := s.q.ListCompletedInterbank(ctx, transfersdb.ListCompletedInterbankParams{
		Partner: ptr(s.partner.Name()), FromAt: from, ToAt: to,
	})
	if err != nil {
		return Reconciliation{}, fmt.Errorf("list completed interbank transfers: %w", err)
	}

	out := Reconciliation{Date: from, Partner: s.partner.Name(), GeneratedAt: s.now()}
	ledger := make(map[string]money.Money, len(paid))
	for _, p := range paid {
		ledger[p.Reference] = money.New(p.AmountMinor, money.Currency(p.Currency))
	}
	seen := make(map[string]bool, len(file))
	for _, line := range file {
		seen[line.Reference] = true
		partner := line.Amount
		item := ReconItem{Reference: line.Reference, Partner: &partner}
		if l, ok := ledger[line.Reference]; ok {
			if l == partner {
				out.Matched++
				continue
			}
			item.Status, item.Ledger = ReconAmountMismatch, &l
		} else {
			// The ledger may have completed it on the other side of midnight.
			same, err := s.completedFor(ctx, line.Reference, partner)
			if err != nil {
				return Reconciliation{}, err
			}
			if same {
				out.Matched++
				continue
			}
			item.Status = ReconMissingInLedger
		}
		out.Items = append(out.Items, item)
	}
	for ref, l := range ledger {
		if seen[ref] {
			continue
		}
		// The ledger paid out in this window and the file has no line for it. The partner's
		// own status answer says whether it settled in another window or was lost.
		res, err := s.partner.Status(ctx, ref)
		if err != nil {
			return Reconciliation{}, fmt.Errorf("status of %s: %w", ref, err)
		}
		if res.State == partners.Settled {
			out.Matched++
			continue
		}
		out.Items = append(out.Items, ReconItem{Reference: ref, Status: ReconMissingAtPartner, Ledger: &l})
	}
	sort.Slice(out.Items, func(i, j int) bool { return out.Items[i].Reference < out.Items[j].Reference })
	return out, nil
}

// completedFor reports whether the transfer with this reference is completed for amount,
// whatever day it completed.
func (s *Service) completedFor(ctx context.Context, ref string, amount money.Money) (bool, error) {
	t, err := s.q.GetTransferByReference(ctx, ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("load transfer %s: %w", ref, err)
	}
	return Status(t.Status) == Completed && money.New(t.AmountMinor, money.Currency(t.Currency)) == amount, nil
}

// ReconcileArgs is the daily reconciliation job.
type ReconcileArgs struct{}

// Kind implements river.JobArgs.
func (ReconcileArgs) Kind() string { return "transfer_reconcile" }

// InsertOpts implements river.JobArgsWithInsertOpts: one run per hour however many
// instances schedule it.
func (ReconcileArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{UniqueOpts: river.UniqueOpts{ByPeriod: time.Hour}}
}

type reconcileWorker struct {
	river.WorkerDefaults[ReconcileArgs]
	s *Service
}

func (w *reconcileWorker) Work(ctx context.Context, _ *river.Job[ReconcileArgs]) error {
	return w.s.ReconcileYesterday(ctx)
}

// ReconcileYesterday reconciles the Lagos day that just ended and logs every mismatch at
// error level, which reaches Sentry: money the saga cannot fix needs a person.
func (s *Service) ReconcileYesterday(ctx context.Context) error {
	r, err := s.Reconcile(ctx, s.now().In(lagos).AddDate(0, 0, -1))
	if errors.Is(err, errNoSettlementFile) {
		return nil // the partner publishes no file: nothing to reconcile
	}
	if err != nil {
		return err
	}
	day := r.Date.Format(time.DateOnly)
	for _, it := range r.Items {
		s.log.ErrorContext(ctx, "reconciliation mismatch", slog.String("partner", r.Partner),
			slog.String("date", day), slog.String("reference", it.Reference), slog.String("status", it.Status))
	}
	s.log.InfoContext(ctx, "reconciliation done", slog.String("partner", r.Partner), slog.String("date", day),
		slog.Int("matched", r.Matched), slog.Int("unmatched", len(r.Items)))
	return nil
}

func moneyJSON(m *money.Money) *api.Money {
	if m == nil {
		return nil
	}
	j := accounts.Money(*m)
	return &j
}

// GetReconciliationReport is GET /v1/admin/ledger/reconciliation.
func (a *API) GetReconciliationReport(ctx context.Context, req api.GetReconciliationReportRequestObject) (api.GetReconciliationReportResponseObject, error) {
	if a == nil {
		return nil, api.ErrNotImplemented
	}
	r, err := a.svc.Reconcile(ctx, req.Params.Date.Time)
	if err != nil {
		return nil, err
	}
	out := api.GetReconciliationReport200JSONResponse{
		Date: api.Date{Time: r.Date}, GeneratedAt: r.GeneratedAt.UTC(), Partner: r.Partner,
		Matched: r.Matched, Unmatched: len(r.Items), Items: make([]api.ReconciliationItem, len(r.Items)),
	}
	for i, it := range r.Items {
		out.Items[i] = api.ReconciliationItem{
			Reference: it.Reference, Status: api.ReconciliationItemStatus(it.Status),
			PartnerAmount: moneyJSON(it.Partner), LedgerAmount: moneyJSON(it.Ledger),
		}
	}
	return out, nil
}
