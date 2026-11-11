package console

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	openapi_types "github.com/oapi-codegen/runtime/types"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console/consoledb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

var lagos = time.FixedZone("WAT", 3600)

// Dashboard is the KPI page (ADM-2). The period is inclusive Lagos dates and defaults to the last
// 30 days.
func (s *Service) Dashboard(ctx context.Context, from, to *time.Time) (api.AdminDashboard, error) {
	if _, err := staff(ctx); err != nil {
		return api.AdminDashboard{}, err
	}
	now := s.now()
	today := now.In(lagos)
	end := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	start := end.AddDate(0, 0, -29)
	if to != nil {
		end = time.Date(to.Year(), to.Month(), to.Day(), 0, 0, 0, 0, time.UTC)
	}
	if from != nil {
		start = time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, time.UTC)
	}
	if start.After(end) {
		return api.AdminDashboard{}, problem.Validation(problem.Field("/from", "after_to", "The start date must not be after the end date."))
	}
	if end.Sub(start) > 366*24*time.Hour {
		return api.AdminDashboard{}, problem.Validation(problem.Field("/from", "range_too_long", "Pick a period of up to a year."))
	}
	// Lagos days start an hour before UTC midnight.
	lo := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, lagos)
	hi := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, lagos).AddDate(0, 0, 1)

	out := api.AdminDashboard{PeriodFrom: openapi_types.Date{Time: start}, PeriodTo: openapi_types.Date{Time: end}}
	users, err := s.q.DashboardUsers(ctx, consoledb.DashboardUsersParams{FromTime: lo, ToTime: hi, Now: now})
	if err != nil {
		return api.AdminDashboard{}, fmt.Errorf("dashboard users: %w", err)
	}
	out.UsersTotal, out.UsersNew, out.UsersActive30d = int(users.Total), int(users.NewUsers), int(users.Active30d)

	vol, err := s.q.DashboardVolume(ctx, consoledb.DashboardVolumeParams{FromTime: lo, ToTime: hi})
	if err != nil {
		return api.AdminDashboard{}, fmt.Errorf("dashboard volume: %w", err)
	}
	out.Volume = make([]api.CurrencyVolume, len(vol))
	for i, v := range vol {
		out.Volume[i] = api.CurrencyVolume{Currency: api.CurrencyCode(v.Currency), Inflow: apiMoney(v.Inflow, v.Currency), Outflow: apiMoney(v.Outflow, v.Currency), Count: int(v.Entries)}
	}

	by, err := s.q.DashboardTransfersByStatus(ctx, consoledb.DashboardTransfersByStatusParams{FromTime: lo, ToTime: hi})
	if err != nil {
		return api.AdminDashboard{}, fmt.Errorf("dashboard transfers: %w", err)
	}
	out.TransfersByStatus = make([]struct {
		Count  int                `json:"count"`
		Status api.TransferStatus `json:"status"`
	}, len(by))
	for i, b := range by {
		out.TransfersByStatus[i].Status, out.TransfersByStatus[i].Count = api.TransferStatus(b.Status), int(b.N)
	}

	fr, err := s.q.DashboardFraudRate(ctx, consoledb.DashboardFraudRateParams{FromTime: lo, ToTime: hi})
	if err != nil {
		return api.AdminDashboard{}, fmt.Errorf("dashboard fraud rate: %w", err)
	}
	if fr.Scored > 0 {
		out.FraudHoldRateBps = int(int64(fr.Held) * 10_000 / int64(fr.Scored))
	}

	pnl, err := s.fx.Pnl(ctx, start, end)
	if err != nil {
		return api.AdminDashboard{}, err
	}
	out.FxPnl = make([]api.Money, len(pnl.Lines))
	for i, l := range pnl.Lines {
		out.FxPnl[i] = apiMoney(l.Spread.Amount(), string(l.Spread.Currency()))
	}

	q, err := s.q.DashboardQueues(ctx, now)
	if err != nil {
		return api.AdminDashboard{}, fmt.Errorf("dashboard queues: %w", err)
	}
	out.Queues.KycPending, out.Queues.FraudOpen, out.Queues.DisputesOpen = int(q.KycPending), int(q.FraudOpen), int(q.DisputesOpen)
	out.Queues.SupportOpen, out.Queues.ApprovalsPending = int(q.SupportOpen), int(q.ApprovalsPending)
	return out, nil
}

// AuditLog pages through the audit log, newest first.
func (s *Service) AuditLog(ctx context.Context, p api.ListAuditLogParams) (api.AuditEntryPage, error) {
	if _, err := staff(ctx); err != nil {
		return api.AuditEntryPage{}, err
	}
	cur, err := pagination.Decode(p.Cursor)
	if err != nil {
		return api.AuditEntryPage{}, err
	}
	afterSeq := int64(1) << 62
	if !cur.IsZero() {
		afterSeq = cur.Time.UnixMicro() // the sequence rides in the cursor's time field
	}
	var from, to *time.Time
	if p.From != nil {
		from = &p.From.Time
	}
	if p.To != nil {
		to = &p.To.Time
	}
	lo, hi := dateRange(from, to)
	n := pagination.Limit(p.Limit)
	args := consoledb.ListAuditEntriesParams{FromTime: lo, ToTime: hi, AfterSeq: afterSeq, PageSize: int32(n + 1)} //nolint:gosec // n is at most 100
	if p.ActorId != nil {
		args.ActorID = p.ActorId.String()
	}
	if p.Action != nil {
		args.Action = *p.Action
	}
	if p.ResourceId != nil {
		args.ResourceID = *p.ResourceId
	}
	rows, err := s.q.ListAuditEntries(ctx, args)
	if err != nil {
		return api.AuditEntryPage{}, fmt.Errorf("list audit: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r consoledb.AuditLog) pagination.Cursor {
		return pagination.Cursor{Time: time.UnixMicro(r.Seq).UTC()}
	})
	out := api.AuditEntryPage{Page: page, Data: make([]api.AuditEntry, len(rows))}
	for i, r := range rows {
		e := api.AuditEntry{
			Seq: int(r.Seq), Id: r.ID, At: r.At.UTC(), Action: r.Action, Metadata: map[string]any{}, Ip: r.Ip, PrevHash: r.PrevHash, Hash: r.Hash,
		}
		e.Actor.Type, e.Actor.Id, e.Actor.Name = api.AuditEntryActorType(r.ActorType), r.ActorID, r.ActorName
		e.Resource.Type, e.Resource.Id = r.ResourceType, r.ResourceID
		if len(r.Metadata) > 0 {
			if err := jsonUnmarshal(r.Metadata, &e.Metadata); err != nil {
				return api.AuditEntryPage{}, fmt.Errorf("decode audit metadata: %w", err)
			}
		}
		out.Data[i] = e
	}
	return out, nil
}

// VerifyAuditLog recomputes the hash chain over a range, or all of it, and says where it breaks.
func (s *Service) VerifyAuditLog(ctx context.Context, fromSeq, toSeq *int) (api.AuditVerification, error) {
	p, err := staff(ctx)
	if err != nil {
		return api.AuditVerification{}, err
	}
	var f, t int64
	if fromSeq != nil {
		f = int64(*fromSeq)
	}
	if toSeq != nil {
		t = int64(*toSeq)
	}
	v, err := audit.Verify(ctx, s.pool, f, t)
	if err != nil {
		return api.AuditVerification{}, err
	}
	out := api.AuditVerification{Valid: v.Valid, Checked: int(v.Checked), HeadSeq: int(v.HeadSeq), HeadHash: v.HeadHash, VerifiedAt: s.now().UTC()}
	if v.FirstBrokenSeq != nil {
		b := int(*v.FirstBrokenSeq)
		out.FirstBrokenSeq = &b
	}
	// Verifying is itself worth a line in the log (who looked for tampering, and what they found).
	if err := s.inTx(ctx, func(tx pgx.Tx, _ *consoledb.Queries) error {
		return s.record(ctx, tx, actorOf(p), "audit.verify", "audit_log", "chain", map[string]any{"valid": v.Valid, "checked": v.Checked})
	}); err != nil {
		return api.AuditVerification{}, err
	}
	return out, nil
}
