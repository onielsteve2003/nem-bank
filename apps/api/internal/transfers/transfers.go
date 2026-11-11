// Package transfers moves money between customers (FR-TRF). A transfer is a state machine
// (contract TransferStatus) whose every step is written to an append-only timeline; the
// database refuses any move the machine does not allow (migration 00014).
//
// The internal rail (Nem to Nem) is instant: the transfer, its timeline, the journal
// entry and both customers' transaction lines commit in one database transaction, so a
// transfer is either completed with the money moved or never happened at all.
package transfers

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/risk"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// Status is a contract TransferStatus.
type Status string

// The states of a transfer.
const (
	Created       Status = "created"
	RiskChecked   Status = "risk_checked"
	PendingStepUp Status = "pending_step_up"
	Delayed       Status = "delayed"
	HeldForReview Status = "held_for_review"
	Processing    Status = "processing"
	Completed     Status = "completed"
	Failed        Status = "failed"
	Reversed      Status = "reversed"
	Rejected      Status = "rejected"
	Cancelled     Status = "cancelled"
)

// transitions is the state machine. The database trigger transfers_check_transition holds
// the same table, so a move refused here is refused there too.
var transitions = map[Status][]Status{
	Created:       {RiskChecked, Rejected},
	RiskChecked:   {PendingStepUp, Delayed, HeldForReview, Processing, Completed, Rejected},
	PendingStepUp: {Processing, Completed, Cancelled, Rejected},
	Delayed:       {Processing, Completed, Cancelled},
	HeldForReview: {Processing, Completed, Rejected, Cancelled},
	Processing:    {Completed, Failed},
	Failed:        {Reversed},
}

// CanMove reports whether the machine allows from → to.
func CanMove(from, to Status) bool {
	for _, s := range transitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

// Terminal reports whether no move leaves s.
func Terminal(s Status) bool { return len(transitions[s]) == 0 }

// Problems, with the mock bank's codes (apps/mobile/src/data/mock/domains/transfers.ts).
var (
	ErrTransferNotFound = problem.NotFound("Transfer")
	errNotNaira         = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Transfers go out from your naira account")
	errOwnAccount       = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "That is your own account").
				WithDetail("Move money between your own accounts from the account screen.")
	errOutgoingBlocked = problem.New(http.StatusForbidden, "outgoing_blocked", "Outgoing payments are paused").
				WithDetail("This account cannot send money right now. Contact support.")
	errMaxBalance = problem.New(http.StatusUnprocessableEntity, "max_balance_exceeded", "This would go over their balance limit").
			WithDetail("The person you are paying cannot receive this much until they upgrade their KYC tier.")
	// errStale means the transfer moved under us between read and update: a programmer
	// error or a lost race, never a customer mistake.
	errStale = errors.New("transfers: status changed concurrently")
)

// Customers is what transfers needs from identity: who a customer is, who a payee's
// @nemtag or phone belongs to, and the calling device's cool-off.
type Customers interface {
	accounts.Customers
	FindCustomer(ctx context.Context, handle string) (uuid.UUID, error)
	CoolOff(ctx context.Context) (identity.CoolOff, error)
}

// Family applies a guardian's controls to a dependant's transfers (FAM-2).
type Family interface {
	// Screen runs on a planned transfer before anything is written. It returns nil for a
	// customer who is not a dependant or a transfer inside the controls, and otherwise the
	// problem to answer with (after setting the transfer aside for the guardian, when that is
	// what the controls ask for).
	Screen(ctx context.Context, c FamilyCheck) error
}

// FamilyCheck is a planned transfer, for Family.Screen.
type FamilyCheck struct {
	UserID  uuid.UUID
	Request Request
	// Amount is what the recipient gets; Total adds the fee.
	Amount, Total money.Money
	Interbank     bool
	Recipient     api.TransferParty
	// NoApproval is set for a scheduled run, which cannot wait for a guardian: above the
	// approval threshold it is refused instead.
	NoApproval bool
}

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Accounts  *accounts.Service
	Customers Customers
	// Limits counts transfers against the daily limits and prices them; nil builds one on
	// Pool with the default rules.
	Limits *limits.Service
	// StepUps spends the step-up that skips a cooling-off; nil means none is ever valid.
	StepUps limits.StepUps
	// Risk scores every transfer before it goes (AI-1); nil means no risk checks.
	Risk *risk.Service
	// QRKey signs receive QR payloads (at least 32 bytes); nil makes a random one, so codes
	// only verify in the process that made them (tests).
	QRKey []byte
	// Partner carries money to other banks; nil means Sandbox.
	Partner partners.BankPartner
	// Sandbox is the simulated rail, whose settings staff change from the console; nil
	// builds one on Pool with no callbacks.
	Sandbox *partners.SandboxNIP
	// WebhookSecrets verify partner callbacks, by partner name. A partner without one
	// cannot call back (its transfers settle by status query).
	WebhookSecrets map[string][]byte
	// SagaTimeout is how long an interbank transfer waits for the partner before its money
	// is given back; default DefaultSagaTimeout. PollAfter is the first status check's
	// delay, doubling after; default DefaultPollAfter.
	SagaTimeout, PollAfter time.Duration
	Logger                 *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service implements transfers.
type Service struct {
	pool      *pgxpool.Pool
	q         *transfersdb.Queries
	accounts  *accounts.Service
	customers Customers
	limits    *limits.Service
	stepUps   limits.StepUps
	risk      *risk.Service
	family    Family
	qrKey     []byte
	partner   partners.BankPartner
	sandbox   *partners.SandboxNIP
	secrets   map[string][]byte
	insert    *river.Client[pgx.Tx]
	log       *slog.Logger
	// sagaTimeout and pollAfter pace the interbank saga.
	sagaTimeout, pollAfter time.Duration
	now                    func() time.Time
}

// SetFamily installs the family controls. They are set after construction because the family
// service sends money through this one (SendAs), so neither can be built first.
func (s *Service) SetFamily(f Family) { s.family = f }

// NewService checks the configuration and returns the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Customers == nil || cfg.Logger == nil {
		return nil, errors.New("transfers: pool, accounts, customers and logger are required")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Sandbox == nil {
		sb, err := partners.NewSandboxNIP(partners.SandboxConfig{Pool: cfg.Pool, Logger: cfg.Logger, Now: cfg.Now})
		if err != nil {
			return nil, err
		}
		cfg.Sandbox = sb
	}
	if cfg.Partner == nil {
		cfg.Partner = cfg.Sandbox
	}
	if cfg.QRKey == nil {
		cfg.QRKey = make([]byte, 32)
		if _, err := rand.Read(cfg.QRKey); err != nil {
			return nil, fmt.Errorf("qr key: %w", err)
		}
	}
	if len(cfg.QRKey) < 32 {
		return nil, errors.New("transfers: QRKey must be at least 32 bytes")
	}
	if cfg.Limits == nil {
		l, err := limits.NewService(limits.Config{Pool: cfg.Pool, Customers: cfg.Customers, Now: cfg.Now})
		if err != nil {
			return nil, err
		}
		cfg.Limits = l
	}
	if cfg.SagaTimeout <= 0 {
		cfg.SagaTimeout = DefaultSagaTimeout
	}
	if cfg.PollAfter <= 0 {
		cfg.PollAfter = DefaultPollAfter
	}
	// Insert-only: the process's jobs.Runner works the saga's jobs (Register).
	insert, err := river.NewClient(riverpgxv5.New(cfg.Pool), &river.Config{Logger: cfg.Logger})
	if err != nil {
		return nil, fmt.Errorf("transfers job client: %w", err)
	}
	return &Service{
		pool: cfg.Pool, q: transfersdb.New(cfg.Pool), accounts: cfg.Accounts, customers: cfg.Customers,
		limits: cfg.Limits, stepUps: cfg.StepUps, risk: cfg.Risk, qrKey: cfg.QRKey, partner: cfg.Partner, sandbox: cfg.Sandbox, secrets: cfg.WebhookSecrets, insert: insert,
		log: cfg.Logger, now: cfg.Now, sagaTimeout: cfg.SagaTimeout, pollAfter: cfg.PollAfter,
	}, nil
}

// target is where a transfer goes: a Nem account (internal) or an account at another bank
// that name enquiry found (interbank).
type target struct {
	nem     *accounts.Recipient
	bank    partners.Bank
	account partners.AccountName
	party   api.TransferParty
	// saved is the customer's beneficiary for this account, if they saved it.
	saved *transfersdb.Beneficiary
}

func (d target) internal() bool { return d.nem != nil }

// rail is the contract TransferRail the target goes over.
func (d target) rail() string {
	if d.internal() {
		return "internal"
	}
	return "interbank"
}

// internalLegs moves amount from src to dst, the levy (if any) going from what dst
// receives to the levy account the bank remits to the government.
func internalLegs(ctx context.Context, tx pgx.Tx, src, dst uuid.UUID, amount, levy money.Money) ([]ledger.Leg, error) {
	if !levy.IsPositive() {
		return []ledger.Leg{ledger.Debit(src, amount), ledger.Credit(dst, amount)}, nil
	}
	levyAcct, err := ledger.SystemAccount(ctx, tx, ledger.KindLevyPayable, string(money.NGN))
	if err != nil {
		return nil, err
	}
	net, err := amount.Sub(levy)
	if err != nil {
		return nil, err
	}
	return []ledger.Leg{ledger.Debit(src, amount), ledger.Credit(dst, net), ledger.Credit(levyAcct.ID, levy)}, nil
}

func balanceAfter(p ledger.Posted, account uuid.UUID) int64 {
	for _, x := range p.Postings {
		if x.AccountID == account {
			return x.BalanceAfterMinor
		}
	}
	return 0
}

func nemTarget(r accounts.Recipient) target {
	return target{nem: &r, party: api.TransferParty{
		Name: r.Name, Nemtag: r.Nemtag, BankCode: accounts.BankCode, BankName: accounts.BankName,
		AccountNumberMasked: accounts.MaskNumber(r.AccountNumber),
	}}
}

// resolveAccount finds the account a Nem or bank destination names.
func (s *Service) resolveAccount(ctx context.Context, d api.TransferDestination) (target, error) {
	kind, err := d.Discriminator()
	if err != nil {
		return target{}, fmt.Errorf("destination: %w", err)
	}
	switch kind {
	case "nem":
		n, err := d.AsNemDestination()
		if err != nil {
			return target{}, fmt.Errorf("destination: %w", err)
		}
		r, err := s.accounts.ResolveNuban(ctx, n.AccountNumber)
		if err != nil {
			return target{}, err
		}
		return nemTarget(r), nil
	case "bank":
		b, err := d.AsBankDestination()
		if err != nil {
			return target{}, fmt.Errorf("destination: %w", err)
		}
		if b.BankCode == accounts.BankCode {
			r, err := s.accounts.ResolveNuban(ctx, b.AccountNumber)
			if err != nil {
				return target{}, err
			}
			return nemTarget(r), nil
		}
		bank, ok := partners.BankByCode(b.BankCode)
		if !ok {
			return target{}, errUnknownBank
		}
		// The name the bank holds, not the one typed: the customer saw it (and the CoP
		// verdict) on the review screen, and it is what their statement should say.
		acct, err := s.partner.NameEnquiry(ctx, bank.Code, b.AccountNumber)
		if errors.Is(err, partners.ErrAccountNotFound) {
			return target{}, errNoSuchAccountElsewhere
		}
		if err != nil {
			return target{}, fmt.Errorf("name enquiry: %w", err)
		}
		return target{bank: bank, account: acct, party: api.TransferParty{
			Name: acct.Name, BankCode: bank.Code, BankName: bank.Name, AccountNumberMasked: accounts.MaskNumber(acct.AccountNumber),
		}}, nil
	default:
		return target{}, fmt.Errorf("destination: unexpected kind %q", kind)
	}
}

// move advances t to the next state and records the step, refusing a move the machine
// does not allow before the database would.
func (s *Service) move(ctx context.Context, q *transfersdb.Queries, t transfersdb.Transfer, to Status, label string, detail *string, entry *uuid.UUID) (transfersdb.Transfer, error) {
	if !CanMove(Status(t.Status), to) {
		return t, fmt.Errorf("transfers: %s cannot go from %s to %s", t.ID, t.Status, to)
	}
	next, err := q.SetTransferStatus(ctx, transfersdb.SetTransferStatusParams{
		ID: t.ID, FromStatus: t.Status, ToStatus: string(to), EntryID: entry,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return t, fmt.Errorf("%w: %s", errStale, t.ID)
	}
	if err != nil {
		return t, fmt.Errorf("set transfer status: %w", err)
	}
	return next, event(ctx, q, t.ID, to, label, detail)
}

func event(ctx context.Context, q *transfersdb.Queries, id uuid.UUID, status Status, label string, detail *string) error {
	if err := q.InsertTransferEvent(ctx, transfersdb.InsertTransferEventParams{
		TransferID: id, Status: string(status), Label: label, Detail: detail,
	}); err != nil {
		return fmt.Errorf("transfer event: %w", err)
	}
	return nil
}

func insufficient(amount money.Money) error {
	return ledger.ErrInsufficientFunds.WithDetailf("You need ₦%s including the fee.", accounts.FormatAmount(amount.Amount()))
}

// StopDuressTransfers marks every transfer the customer "sent" under duress as stopped,
// inside the PIN check that ended duress (identity.Config.OnDuressEnded). No money moved,
// so there is nothing to give back.
func (s *Service) StopDuressTransfers(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	q := s.q.WithTx(tx)
	ts, err := q.LockDuressTransfers(ctx, userID)
	if err != nil {
		return fmt.Errorf("lock duress transfers: %w", err)
	}
	detail := "Sent while your duress PIN was in use. No money left your account."
	for _, t := range ts {
		if _, err := s.move(ctx, q, t, Failed, "Stopped by Nem", &detail, nil); err != nil {
			return err
		}
		if _, err := accounts.Settle(ctx, tx, t.TransactionID, "failed", nil, t.SourceAccountID); err != nil {
			return err
		}
		if err := s.releaseLimit(ctx, tx, t); err != nil {
			return err
		}
	}
	return nil
}

// releaseLimit gives a transfer that moved no money back to the day it was counted on.
func (s *Service) releaseLimit(ctx context.Context, tx pgx.Tx, t transfersdb.Transfer) error {
	if t.LimitDay == nil { // sent before limits were counted
		return nil
	}
	return s.limits.Release(ctx, tx, t.UserID, *t.LimitDay, money.New(t.AmountMinor, money.Currency(t.Currency)))
}

// Get returns one of the caller's transfers.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (View, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return View{}, problem.Unauthorized()
	}
	return s.view(ctx, p.UserID, id)
}

func (s *Service) view(ctx context.Context, userID, id uuid.UUID) (View, error) {
	t, err := s.q.GetTransfer(ctx, transfersdb.GetTransferParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return View{}, ErrTransferNotFound
	}
	if err != nil {
		return View{}, fmt.Errorf("load transfer: %w", err)
	}
	evs, err := s.q.ListTransferEvents(ctx, []uuid.UUID{id})
	if err != nil {
		return View{}, fmt.Errorf("load timeline: %w", err)
	}
	return View{Transfer: t, Timeline: evs}, nil
}

// List pages through the caller's transfers, newest first, timelines loaded in one query.
func (s *Service) List(ctx context.Context, status *string, cursor *string, limit *int) ([]View, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListTransfers(ctx, transfersdb.ListTransfersParams{
		UserID: p.UserID, Status: status, AfterID: after.ID, AfterAt: after.Time, Lim: int32(n + 1), //nolint:gosec // n ≤ pagination.MaxLimit
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list transfers: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(t transfersdb.Transfer) pagination.Cursor {
		return pagination.Cursor{Time: t.CreatedAt, ID: t.ID}
	})
	ids := make([]uuid.UUID, len(rows))
	for i, t := range rows {
		ids[i] = t.ID
	}
	evs, err := s.q.ListTransferEvents(ctx, ids)
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("load timelines: %w", err)
	}
	byID := map[uuid.UUID][]transfersdb.TransferEvent{}
	for _, e := range evs {
		byID[e.TransferID] = append(byID[e.TransferID], e)
	}
	out := make([]View, len(rows))
	for i, t := range rows {
		out[i] = View{Transfer: t, Timeline: byID[t.ID]}
	}
	return out, page, nil
}

// Timeline is a transfer's steps for its transaction's detail (accounts.Config.Timelines).
// accounts has already checked the caller owns the line.
func (s *Service) Timeline(ctx context.Context, id uuid.UUID) ([]api.TimelineEvent, error) {
	evs, err := s.q.ListTransferEvents(ctx, []uuid.UUID{id})
	if err != nil {
		return nil, fmt.Errorf("load timeline: %w", err)
	}
	return timelineJSON(evs), nil
}

// referenceAlphabet leaves out 0/O and 1/I, which customers read out to support.
const referenceAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// newReference is "NEM" + the Lagos date + six random characters, like NEM20261017A8F3K2.
func newReference(now time.Time) (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("reference: %w", err)
	}
	out := []byte("NEM" + now.In(time.FixedZone("WAT", 3600)).Format("20060102"))
	for _, c := range b {
		out = append(out, referenceAlphabet[int(c)%len(referenceAlphabet)]) // 256 % 32 == 0: unbiased
	}
	return string(out), nil
}

func newIDs(n int) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, n)
	for i := range out {
		id, err := uuid.NewV7()
		if err != nil {
			return nil, fmt.Errorf("new id: %w", err)
		}
		out[i] = id
	}
	return out, nil
}
