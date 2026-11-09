package transfers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// Money requests (TRF-10) and split bills (TRF-11). A request asks one Nem customer for an
// amount; a split bill is one request per participant. Paying a request is a normal
// transfer to the requester, committed with the request marked paid.

const (
	// MaxSplitParticipants is @nem/shared's cap on people in one split bill.
	MaxSplitParticipants = 20
	// SplitRemindEvery is how often each unpaid participant may be reminded.
	SplitRemindEvery = 24 * time.Hour
	// splitRequestDays is how long a split bill's requests stay open.
	splitRequestDays = 7
)

var (
	// ErrRequestNotFound is the 404 for a request the caller is not party to.
	ErrRequestNotFound = problem.NotFound("Request")
	// ErrSplitNotFound is the 404 for a split bill the caller did not create.
	ErrSplitNotFound = problem.NotFound("Split bill")
	errRequestClosed = problem.New(http.StatusConflict, "invalid_state", "This request is no longer open")
	errAskYourself   = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "You cannot request money from yourself")
)

func splitError(title string) error {
	return problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, title)
}

// Party is a customer as requests show them (contract PartySummary).
type Party struct {
	UserID uuid.UUID
	identity.CustomerProfile
}

// RequestView is a request with both parties, from the caller's side.
type RequestView struct {
	transfersdb.MoneyRequest
	Incoming         bool
	Requester, Payer Party
}

func (s *Service) party(ctx context.Context, id uuid.UUID) (Party, error) {
	p, err := s.customers.CustomerProfile(ctx, id)
	if err != nil {
		return Party{}, err
	}
	return Party{UserID: id, CustomerProfile: p}, nil
}

func (s *Service) requestView(ctx context.Context, caller uuid.UUID, r transfersdb.MoneyRequest) (RequestView, error) {
	req, err := s.party(ctx, r.RequesterID)
	if err != nil {
		return RequestView{}, err
	}
	payer, err := s.party(ctx, r.PayerID)
	if err != nil {
		return RequestView{}, err
	}
	return RequestView{MoneyRequest: r, Incoming: r.PayerID == caller, Requester: req, Payer: payer}, nil
}

// findByTag finds a customer by @nemtag ("ada" or "@ada").
func (s *Service) findByTag(ctx context.Context, tag string) (uuid.UUID, error) {
	id, err := s.customers.FindCustomer(ctx, "@"+strings.TrimPrefix(strings.TrimSpace(tag), "@"))
	if errors.Is(err, identity.ErrNoSuchCustomer) {
		return uuid.Nil, problem.NotFound("Nem user").WithDetailf("No Nem user is @%s.", strings.TrimPrefix(strings.TrimSpace(tag), "@"))
	}
	return id, err
}

func (s *Service) insertRequest(ctx context.Context, tx pgx.Tx, requester, payer uuid.UUID, amount money.Money, note string, days int, split *uuid.UUID) (transfersdb.MoneyRequest, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return transfersdb.MoneyRequest{}, fmt.Errorf("request id: %w", err)
	}
	now := s.now()
	r, err := s.q.WithTx(tx).InsertMoneyRequest(ctx, transfersdb.InsertMoneyRequestParams{
		ID: id, RequesterID: requester, PayerID: payer, Currency: string(money.NGN), AmountMinor: amount.Amount(),
		Note: note, SplitBillID: split, CreatedAt: now, ExpiresAt: now.AddDate(0, 0, days),
	})
	if err != nil {
		return r, fmt.Errorf("insert request: %w", err)
	}
	// For the notifications subscriber: "Ada requested ₦5,000".
	_, err = jobs.Write(ctx, tx, jobs.Event{
		Topic: "money_request.created", AggregateType: "money_request", AggregateID: id.String(),
		Payload: map[string]any{"request_id": id, "requester_id": requester, "payer_id": payer, "amount_minor": amount.Amount(), "currency": "NGN"},
	})
	return r, err
}

// CreateRequest asks a Nem customer for money.
func (s *Service) CreateRequest(ctx context.Context, payerTag string, amount money.Money, note string, days int) (RequestView, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return RequestView{}, problem.Unauthorized()
	}
	if amount.Currency() != money.NGN {
		return RequestView{}, errNotNaira
	}
	if !amount.IsPositive() {
		return RequestView{}, problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
	}
	payer, err := s.findByTag(ctx, payerTag)
	if err != nil {
		return RequestView{}, err
	}
	if payer == p.UserID {
		return RequestView{}, errAskYourself
	}
	var r transfersdb.MoneyRequest
	if err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		r, err = s.insertRequest(ctx, tx, p.UserID, payer, amount, strings.TrimSpace(note), days, nil)
		return err
	}); err != nil {
		return RequestView{}, err
	}
	return s.requestView(ctx, p.UserID, r)
}

// GetRequest returns a request the caller sent or received.
func (s *Service) GetRequest(ctx context.Context, id uuid.UUID) (RequestView, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return RequestView{}, problem.Unauthorized()
	}
	if err := s.expireRequests(ctx, p.UserID); err != nil {
		return RequestView{}, err
	}
	r, err := s.q.GetMoneyRequest(ctx, transfersdb.GetMoneyRequestParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return RequestView{}, ErrRequestNotFound
	}
	if err != nil {
		return RequestView{}, fmt.Errorf("load request: %w", err)
	}
	return s.requestView(ctx, p.UserID, r)
}

func (s *Service) expireRequests(ctx context.Context, userID uuid.UUID) error {
	if err := s.q.ExpireMoneyRequests(ctx, transfersdb.ExpireMoneyRequestsParams{Now: s.now(), UserID: userID}); err != nil {
		return fmt.Errorf("expire requests: %w", err)
	}
	return nil
}

// ListRequests pages the caller's incoming or outgoing requests, newest first.
func (s *Service) ListRequests(ctx context.Context, incoming bool, status, cursor *string, limit *int) ([]RequestView, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	if err := s.expireRequests(ctx, p.UserID); err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListMoneyRequests(ctx, transfersdb.ListMoneyRequestsParams{
		Incoming: incoming, UserID: p.UserID, Status: status, AfterID: after.ID, AfterAt: after.Time, Lim: int32(n + 1), //nolint:gosec // n ≤ pagination.MaxLimit
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list requests: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r transfersdb.MoneyRequest) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	out := make([]RequestView, len(rows))
	for i, r := range rows {
		if out[i], err = s.requestView(ctx, p.UserID, r); err != nil {
			return nil, api.PageInfo{}, err
		}
	}
	return out, page, nil
}

// PayRequest pays an incoming request from one of the caller's accounts: a normal
// transfer to the requester, committed with the request marked paid.
func (s *Service) PayRequest(ctx context.Context, id, sourceAccountID uuid.UUID) (View, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return View{}, problem.Unauthorized()
	}
	if err := s.expireRequests(ctx, p.UserID); err != nil {
		return View{}, err
	}
	r, err := s.q.GetMoneyRequest(ctx, transfersdb.GetMoneyRequestParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return View{}, ErrRequestNotFound
	}
	if err != nil {
		return View{}, fmt.Errorf("load request: %w", err)
	}
	if r.PayerID != p.UserID || r.Status != "pending" {
		return View{}, errRequestClosed
	}
	to, err := s.accounts.ResolveCustomer(ctx, r.RequesterID)
	if err != nil {
		return View{}, err
	}
	dest, err := (target{nem: &to}).destination()
	if err != nil {
		return View{}, err
	}
	coolOff, err := s.customers.CoolOff(ctx)
	if err != nil {
		return View{}, err
	}
	narration := r.Note
	if narration == "" {
		narration = "Request from " + strings.Fields(to.Name)[0]
	}
	pl, err := s.prepare(ctx, p.UserID, Request{
		SourceAccountID: sourceAccountID, Destination: dest, Amount: money.New(r.AmountMinor, money.NGN), Narration: narration, MoneyRequestID: &r.ID,
	}, coolOff)
	if err != nil {
		return View{}, err
	}
	var tid uuid.UUID
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		r, err := q.LockMoneyRequest(ctx, transfersdb.LockMoneyRequestParams{ID: id, UserID: p.UserID})
		if err != nil {
			return fmt.Errorf("lock request: %w", err)
		}
		if r.Status != "pending" || !s.now().Before(r.ExpiresAt) {
			return errRequestClosed
		}
		if tid, err = s.commit(ctx, tx, pl); err != nil {
			return err
		}
		if _, err := q.RespondMoneyRequest(ctx, transfersdb.RespondMoneyRequestParams{ID: id, Status: "paid", TransferID: &tid, RespondedAt: ptr(s.now())}); err != nil {
			return fmt.Errorf("mark request paid: %w", err)
		}
		_, err = jobs.Write(ctx, tx, jobs.Event{
			Topic: "money_request.paid", AggregateType: "money_request", AggregateID: id.String(),
			Payload: map[string]any{"request_id": id, "requester_id": r.RequesterID, "payer_id": r.PayerID, "transfer_id": tid},
		})
		return err
	})
	if err != nil {
		return View{}, err
	}
	return s.view(ctx, p.UserID, tid)
}

// DeclineRequest is the payer saying no; CancelRequest the requester withdrawing it.
func (s *Service) DeclineRequest(ctx context.Context, id uuid.UUID) (RequestView, error) {
	return s.closeRequest(ctx, id, "declined", func(r transfersdb.MoneyRequest, me uuid.UUID) bool { return r.PayerID == me })
}

// CancelRequest withdraws a request the caller sent.
func (s *Service) CancelRequest(ctx context.Context, id uuid.UUID) (RequestView, error) {
	return s.closeRequest(ctx, id, "cancelled", func(r transfersdb.MoneyRequest, me uuid.UUID) bool { return r.RequesterID == me })
}

func (s *Service) closeRequest(ctx context.Context, id uuid.UUID, status string, mine func(transfersdb.MoneyRequest, uuid.UUID) bool) (RequestView, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return RequestView{}, problem.Unauthorized()
	}
	if err := s.expireRequests(ctx, p.UserID); err != nil {
		return RequestView{}, err
	}
	var out transfersdb.MoneyRequest
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		r, err := q.LockMoneyRequest(ctx, transfersdb.LockMoneyRequestParams{ID: id, UserID: p.UserID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRequestNotFound
		}
		if err != nil {
			return fmt.Errorf("lock request: %w", err)
		}
		if !mine(r, p.UserID) || r.Status != "pending" {
			return errRequestClosed
		}
		out, err = q.RespondMoneyRequest(ctx, transfersdb.RespondMoneyRequestParams{ID: id, Status: status, RespondedAt: ptr(s.now())})
		return err
	})
	if err != nil {
		return RequestView{}, err
	}
	return s.requestView(ctx, p.UserID, out)
}

// PartyJSON is the contract's PartySummary.
func PartyJSON(p Party) api.PartySummary {
	return api.PartySummary{UserId: p.UserID, Name: p.Name, Nemtag: p.Nemtag}
}

// RequestJSON is the contract's MoneyRequest.
func RequestJSON(r RequestView) api.MoneyRequest {
	dir := api.Outgoing
	if r.Incoming {
		dir = api.Incoming
	}
	return api.MoneyRequest{
		Id: r.ID, Direction: dir, Requester: PartyJSON(r.Requester), Payer: PartyJSON(r.Payer),
		Amount: accounts.Money(money.New(r.AmountMinor, money.NGN)), Note: r.Note, Status: api.MoneyRequestStatus(r.Status),
		SplitBillId: r.SplitBillID, TransferId: r.TransferID, CreatedAt: r.CreatedAt.UTC(), ExpiresAt: r.ExpiresAt.UTC(),
		RespondedAt: utc(r.RespondedAt),
	}
}

// Participant is one person in a new split bill; Amount is set for custom splits.
type Participant struct {
	Nemtag string
	Amount *money.Money
}

// NewSplit is a split bill to create.
type NewSplit struct {
	Title        string
	Total        money.Money
	Split        string
	IncludeSelf  bool
	Participants []Participant
}

// SplitView is a split bill with its shares.
type SplitView struct {
	transfersdb.SplitBill
	Creator  Party
	Requests []RequestView
}

// equalShares divides total among the friends (and the creator when includeSelf); kobo
// that do not divide evenly go to the creator, or to the first friend if the creator is
// out. The shares always add up to the total (@nem/shared equalShares).
func equalShares(total int64, friends int, includeSelf bool) (self int64, each []int64) {
	heads := int64(friends)
	if includeSelf {
		heads++
	}
	per := total / heads
	rem := total - per*heads
	each = make([]int64, friends)
	for i := range each {
		each[i] = per
	}
	if includeSelf {
		return per + rem, each
	}
	each[0] += rem
	return 0, each
}

// customSharesError is @nem/shared customSharesError: every share positive, no more than
// the total, and exactly the total when the creator is not in it.
func customSharesError(total int64, shares []int64, includeSelf bool) string {
	var asked int64
	for _, s := range shares {
		if s <= 0 {
			return "Give everyone an amount"
		}
		asked += s
	}
	switch {
	case asked > total:
		return "The shares come to more than the total"
	case !includeSelf && asked != total:
		return "The shares must add up to the total"
	}
	return ""
}

// CreateSplit splits a bill: one request to each participant for their share.
func (s *Service) CreateSplit(ctx context.Context, n NewSplit) (SplitView, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return SplitView{}, problem.Unauthorized()
	}
	if n.Total.Currency() != money.NGN {
		return SplitView{}, errNotNaira
	}
	if !n.Total.IsPositive() {
		return SplitView{}, problem.Validation(problem.Field("/total", "positive", "Enter an amount above zero."))
	}
	switch {
	case len(n.Participants) == 0:
		return SplitView{}, splitError("Add at least one person")
	case len(n.Participants) > MaxSplitParticipants:
		return SplitView{}, splitError(fmt.Sprintf("Split with up to %d people", MaxSplitParticipants))
	}
	ids := make([]uuid.UUID, len(n.Participants))
	seen := map[uuid.UUID]bool{p.UserID: true}
	for i, part := range n.Participants {
		id, err := s.findByTag(ctx, part.Nemtag)
		if err != nil {
			return SplitView{}, err
		}
		if seen[id] {
			return SplitView{}, splitError("Add each person once")
		}
		seen[id], ids[i] = true, id
	}
	var self int64
	var amounts []int64
	if n.Split == "equal" {
		self, amounts = equalShares(n.Total.Amount(), len(ids), n.IncludeSelf)
	} else {
		amounts = make([]int64, len(ids))
		var asked int64
		for i, part := range n.Participants {
			if part.Amount == nil {
				return SplitView{}, splitError("Give every person an amount")
			}
			if part.Amount.Currency() != money.NGN {
				return SplitView{}, errNotNaira
			}
			amounts[i] = part.Amount.Amount()
			asked += amounts[i]
		}
		if msg := customSharesError(n.Total.Amount(), amounts, n.IncludeSelf); msg != "" {
			return SplitView{}, splitError(msg)
		}
		self = n.Total.Amount() - asked
	}
	splitID, err := uuid.NewV7()
	if err != nil {
		return SplitView{}, fmt.Errorf("split id: %w", err)
	}
	in := transfersdb.InsertSplitBillParams{
		ID: splitID, UserID: p.UserID, Title: strings.TrimSpace(n.Title), Currency: string(money.NGN), TotalMinor: n.Total.Amount(),
		Split: n.Split, CreatedAt: s.now(),
	}
	if n.IncludeSelf {
		in.SelfMinor = &self
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := q.InsertSplitBill(ctx, in); err != nil {
			return fmt.Errorf("insert split bill: %w", err)
		}
		for i, payer := range ids {
			if _, err := s.insertRequest(ctx, tx, p.UserID, payer, money.New(amounts[i], money.NGN), in.Title, splitRequestDays, &splitID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return SplitView{}, err
	}
	return s.GetSplit(ctx, splitID)
}

// GetSplit returns one of the caller's split bills with who has paid.
func (s *Service) GetSplit(ctx context.Context, id uuid.UUID) (SplitView, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return SplitView{}, problem.Unauthorized()
	}
	b, err := s.q.GetSplitBill(ctx, transfersdb.GetSplitBillParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return SplitView{}, ErrSplitNotFound
	}
	if err != nil {
		return SplitView{}, fmt.Errorf("load split bill: %w", err)
	}
	out, err := s.splitViews(ctx, p.UserID, []transfersdb.SplitBill{b})
	if err != nil {
		return SplitView{}, err
	}
	return out[0], nil
}

// ListSplits pages the caller's split bills, newest first.
func (s *Service) ListSplits(ctx context.Context, cursor *string, limit *int) ([]SplitView, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListSplitBills(ctx, transfersdb.ListSplitBillsParams{UserID: p.UserID, AfterID: after.ID, AfterAt: after.Time, Lim: int32(n + 1)}) //nolint:gosec // n ≤ pagination.MaxLimit
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list split bills: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(b transfersdb.SplitBill) pagination.Cursor {
		return pagination.Cursor{Time: b.CreatedAt, ID: b.ID}
	})
	out, err := s.splitViews(ctx, p.UserID, rows)
	return out, page, err
}

func (s *Service) splitViews(ctx context.Context, caller uuid.UUID, bills []transfersdb.SplitBill) ([]SplitView, error) {
	if err := s.expireRequests(ctx, caller); err != nil {
		return nil, err
	}
	creator, err := s.party(ctx, caller)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(bills))
	for i, b := range bills {
		ids[i] = b.ID
	}
	reqs, err := s.q.ListSplitRequests(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("load split requests: %w", err)
	}
	byBill := map[uuid.UUID][]RequestView{}
	for _, r := range reqs {
		v, err := s.requestView(ctx, caller, r)
		if err != nil {
			return nil, err
		}
		byBill[*r.SplitBillID] = append(byBill[*r.SplitBillID], v)
	}
	out := make([]SplitView, len(bills))
	for i, b := range bills {
		out[i] = SplitView{SplitBill: b, Creator: creator, Requests: byBill[b.ID]}
	}
	return out, nil
}

// RemindSplit reminds the participants still to pay, each at most once a day. When all of
// them were reminded within the day it is a 429 with when the next one is due.
func (s *Service) RemindSplit(ctx context.Context, id uuid.UUID) error {
	v, err := s.GetSplit(ctx, id)
	if err != nil {
		return err
	}
	now := s.now()
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		reminded, err := s.q.WithTx(tx).RemindSplitRequests(ctx, transfersdb.RemindSplitRequestsParams{
			SplitBillID: &id, Now: &now, DueBefore: ptr(now.Add(-SplitRemindEvery)),
		})
		if err != nil {
			return fmt.Errorf("remind split: %w", err)
		}
		if len(reminded) == 0 {
			var next time.Time
			for _, r := range v.Requests {
				if r.Status == "pending" && r.LastRemindedAt != nil && (next.IsZero() || r.LastRemindedAt.Add(SplitRemindEvery).Before(next)) {
					next = r.LastRemindedAt.Add(SplitRemindEvery)
				}
			}
			if next.IsZero() {
				return errRequestClosed.WithDetail("Everyone has already paid or answered.")
			}
			return problem.RateLimited(next).WithDetail("Everyone still to pay was reminded in the last day.")
		}
		for _, r := range reminded {
			if _, err := jobs.Write(ctx, tx, jobs.Event{
				Topic: "money_request.reminded", AggregateType: "money_request", AggregateID: r.ID.String(),
				Payload: map[string]any{"request_id": r.ID, "requester_id": r.RequesterID, "payer_id": r.PayerID, "split_bill_id": id},
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

// SplitJSON is the contract's SplitBill. The creator's own part, when they are in it,
// comes first and counts as paid.
func SplitJSON(v SplitView) api.SplitBill {
	ngn := func(m int64) api.Money { return accounts.Money(money.New(m, money.NGN)) }
	shares := make([]api.SplitShare, 0, len(v.Requests)+1)
	var paid int64
	if v.SelfMinor != nil {
		shares = append(shares, api.SplitShare{Participant: PartyJSON(v.Creator), Amount: ngn(*v.SelfMinor), Status: api.MoneyRequestStatus("paid")})
		paid += *v.SelfMinor
	}
	for _, r := range v.Requests {
		id := r.ID
		shares = append(shares, api.SplitShare{
			Participant: PartyJSON(r.Payer), Amount: ngn(r.AmountMinor), Status: api.MoneyRequestStatus(r.Status),
			MoneyRequestId: &id, LastRemindedAt: utc(r.LastRemindedAt),
		})
		if r.Status == "paid" {
			paid += r.AmountMinor
		}
	}
	return api.SplitBill{
		Id: v.ID, Title: v.Title, Total: ngn(v.TotalMinor), Split: api.SplitBillSplit(v.Split), Shares: shares,
		PaidTotal: ngn(paid), CreatedAt: v.CreatedAt.UTC(),
	}
}
