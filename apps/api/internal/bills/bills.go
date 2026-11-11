package bills

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/bills/billsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Tuning. These are policy, not configuration: each has a reason.
const (
	// vendTimeout bounds the call to the biller, which is made outside any transaction.
	vendTimeout = 15 * time.Second
	// stuckAfter is how old a processing payment must be before the sweep retries it, so
	// the sweep never races a request that is still waiting on the biller.
	stuckAfter = 2 * time.Minute
	// maxAirtime is the most one airtime top-up may buy.
	maxAirtime = 50_000_00
)

// Problems, with the mock bank's codes.
var (
	errNotActive   = problem.New(http.StatusForbidden, "account_not_active", "This account cannot be used right now")
	errNaira       = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pay bills from your naira account")
	errPickPlan    = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick a plan")
	errPlanAmount  = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "The amount does not match the plan")
	errBelowMin    = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "The amount is below the minimum")
	errAboveMax    = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "The amount is above the maximum")
	errPhone       = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Enter a Nigerian phone number")
	errNoCustomer  = problem.New(http.StatusNotFound, "customer_not_found", "We could not find that meter or smartcard number")
	errBillerError = problem.New(http.StatusBadGateway, "biller_unavailable", "The biller is not responding").
			WithDetail("Nothing was charged. Try again in a few minutes.")
	// ErrBillerNotFound is the 404 for a biller that is not in the catalog.
	ErrBillerNotFound = problem.NotFound("Biller")
	// ErrPaymentNotFound is the 404 for a payment the caller did not make.
	ErrPaymentNotFound = problem.NotFound("Bill payment")
)

// Accounts is the customer's accounts; *accounts.Service implements it.
type Accounts interface {
	Owned(ctx context.Context, userID, accountID uuid.UUID) (accountsdb.GetCustomerAccountRow, error)
}

// Customers tells bills a customer's KYC tier and cool-off; identity.Service implements it.
type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
	CoolOff(ctx context.Context) (identity.CoolOff, error)
}

// Limits counts payments against the daily limit; *limits.Service implements it.
type Limits interface {
	Consume(ctx context.Context, tx pgx.Tx, userID uuid.UUID, tier int, c identity.CoolOff, amount money.Money) (time.Time, error)
	Release(ctx context.Context, tx pgx.Tx, userID uuid.UUID, day time.Time, amount money.Money) error
}

var _ Limits = (*limits.Service)(nil)

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Accounts  Accounts
	Customers Customers
	Limits    Limits
	Biller    Biller
	Logger    *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the bills domain.
type Service struct {
	pool      *pgxpool.Pool
	q         *billsdb.Queries
	accounts  Accounts
	customers Customers
	limits    Limits
	biller    Biller
	log       *slog.Logger
	now       func() time.Time
}

// NewService builds the service.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Customers == nil || cfg.Limits == nil || cfg.Biller == nil || cfg.Logger == nil {
		return nil, errors.New("bills: pool, accounts, customers, limits, biller and logger are required")
	}
	s := &Service{
		pool: cfg.Pool, q: billsdb.New(cfg.Pool), accounts: cfg.Accounts, customers: cfg.Customers, limits: cfg.Limits,
		biller: cfg.Biller, log: cfg.Logger.With("component", "bills"), now: cfg.Now,
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s, nil
}

// Billers lists the catalog, optionally for one category.
func (s *Service) Billers(ctx context.Context, category string) ([]Info, error) {
	all, err := s.biller.Billers(ctx)
	if err != nil {
		return nil, fmt.Errorf("list billers: %w", err)
	}
	if category == "" {
		return all, nil
	}
	out := all[:0:0]
	for _, b := range all {
		if b.Category == category {
			out = append(out, b)
		}
	}
	return out, nil
}

func (s *Service) info(ctx context.Context, billerID string) (Info, error) {
	all, err := s.biller.Billers(ctx)
	if err != nil {
		return Info{}, fmt.Errorf("list billers: %w", err)
	}
	for _, b := range all {
		if b.ID == billerID {
			return b, nil
		}
	}
	return Info{}, ErrBillerNotFound
}

// Products lists a biller's bundles or plans.
func (s *Service) Products(ctx context.Context, billerID string) ([]Product, error) {
	if _, err := s.info(ctx, billerID); err != nil {
		return nil, err
	}
	ps, err := s.biller.Products(ctx, billerID)
	if err != nil {
		return nil, fmt.Errorf("list products: %w", err)
	}
	return ps, nil
}

// Validate looks up a meter or smartcard at the biller.
func (s *Service) Validate(ctx context.Context, billerID, customerID string) (Customer, error) {
	b, err := s.info(ctx, billerID)
	if err != nil {
		return Customer{}, err
	}
	if !b.RequiresValidation {
		return Customer{}, problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "This biller does not need validation")
	}
	c, err := s.biller.Validate(ctx, billerID, strings.TrimSpace(customerID))
	switch {
	case errors.Is(err, ErrCustomerNotFound):
		return Customer{}, errNoCustomer
	case err != nil:
		return Customer{}, errBillerError.WithCause(err)
	}
	return c, nil
}

// PayRequest is a bill payment to make (contract PayBillRequest).
type PayRequest struct {
	BillerID   string
	ProductID  string
	CustomerID string
	Amount     money.Money
	Source     uuid.UUID
}

// Payment is a bill payment (contract BillPayment).
type Payment struct {
	ID                   uuid.UUID
	Reference            string
	BillerID, BillerName string
	Category             string
	ProductName          *string
	CustomerID           string
	Amount, Fee          money.Money
	Status               string
	Token, Units         *string
	TransactionID        *uuid.UUID
	CreatedAt            time.Time
}

var categoryOf = map[string]string{
	Airtime: "airtime_data", Data: "airtime_data", Electricity: "bills_utilities", CableTV: "subscriptions",
}

// Pay buys a bill (BILL-1, BILL-2).
//
// The customer is debited first, in one transaction with their history line and the
// payment record, then the biller is asked outside any transaction: a slow biller must not
// hold a database connection. A biller that refuses is repaid by reversing the debit; one
// that cannot be reached leaves the payment processing for the sweep to finish. Either way
// the customer is never left with money gone and nothing delivered.
func (s *Service) Pay(ctx context.Context, req PayRequest) (Payment, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Payment{}, problem.Unauthorized()
	}
	b, err := s.info(ctx, req.BillerID)
	if err != nil {
		return Payment{}, err
	}
	customerID, productName, err := s.check(ctx, b, req)
	if err != nil {
		return Payment{}, err
	}
	src, err := s.accounts.Owned(ctx, p.UserID, req.Source)
	if err != nil {
		return Payment{}, err
	}
	if src.Status != "active" {
		return Payment{}, errNotActive
	}
	if src.Currency != string(money.NGN) {
		return Payment{}, errNaira
	}
	// Reads that go through the pool happen before the transaction opens, so a payment that
	// needed a second connection while holding its first cannot deadlock a busy pool.
	prof, err := s.customers.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return Payment{}, fmt.Errorf("customer profile: %w", err)
	}
	coolOff, err := s.customers.CoolOff(ctx)
	if err != nil {
		return Payment{}, fmt.Errorf("cool-off: %w", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Payment{}, fmt.Errorf("payment id: %w", err)
	}
	lineID, err := uuid.NewV7()
	if err != nil {
		return Payment{}, fmt.Errorf("transaction id: %w", err)
	}
	now := s.now().UTC()
	ref := reference(id)

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		day, err := s.limits.Consume(ctx, tx, p.UserID, prof.KycTier, coolOff, req.Amount)
		if err != nil {
			return err
		}
		settle, err := ledger.SystemAccount(ctx, tx, ledger.KindPartnerSettlement, string(money.NGN))
		if err != nil {
			return err
		}
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "bill_payment", Reference: ref, IdempotencyKey: "bill:" + id.String(),
			Metadata: map[string]any{"payment_id": id.String(), "biller_id": b.ID, "category": b.Category},
			Legs:     []ledger.Leg{ledger.Debit(src.AccountID, req.Amount), ledger.Credit(settle.ID, req.Amount)},
		})
		if err != nil {
			return err
		}
		narration := b.Name
		if productName != "" {
			narration += " " + productName
		}
		if _, err := accounts.Record(ctx, tx, accounts.Line{
			ID: lineID, UserID: p.UserID, AccountID: src.AccountID, Type: "bill_payment", Direction: "debit", Status: "completed",
			Amount: req.Amount, Entry: &posted, Narration: narration, Reference: ref, Category: categoryOf[b.Category],
			Counterparty: api.Counterparty{Name: b.Name}, At: now,
		}); err != nil {
			return err
		}
		params := billsdb.InsertBillPaymentParams{
			ID: id, UserID: p.UserID, AccountID: src.AccountID, Reference: ref, BillerID: b.ID, BillerName: b.Name, Category: b.Category,
			CustomerID: customerID, AmountMinor: req.Amount.Amount(), LimitDay: day, EntryID: &posted.EntryID,
			TransactionID: &lineID, CreatedAt: now,
		}
		if req.ProductID != "" {
			params.ProductID, params.ProductName = &req.ProductID, &productName
		}
		if _, err := billsdb.New(tx).InsertBillPayment(ctx, params); err != nil {
			return fmt.Errorf("insert payment: %w", err)
		}
		return nil
	})
	if err != nil {
		return Payment{}, err
	}
	// The debit is committed. From here the payment is returned whatever the biller does;
	// a failure to reach it is the sweep's to finish, not the customer's to see as an error.
	row, err := s.finish(ctx, id)
	if err != nil {
		s.log.Error("finish bill payment", slog.String("payment_id", id.String()), slog.Any("error", err))
		if row, err = s.q.GetBillPaymentByID(ctx, id); err != nil {
			return Payment{}, fmt.Errorf("reload payment: %w", err)
		}
	}
	return toPayment(row), nil
}

// check validates the request against the catalog and returns the normalised customer ID
// and the chosen product's name.
func (s *Service) check(ctx context.Context, b Info, req PayRequest) (customerID, productName string, err error) {
	if req.Amount.Currency() != money.NGN {
		return "", "", errNaira
	}
	if !req.Amount.IsPositive() {
		return "", "", problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
	}
	customerID = strings.TrimSpace(req.CustomerID)
	if b.HasProducts {
		products, err := s.Products(ctx, b.ID)
		if err != nil {
			return "", "", err
		}
		var chosen *Product
		for i := range products {
			if products[i].ID == req.ProductID {
				chosen = &products[i]
			}
		}
		if chosen == nil {
			return "", "", errPickPlan
		}
		if chosen.Amount != req.Amount {
			return "", "", errPlanAmount
		}
		productName = chosen.Name
	}
	if b.MinAmount.IsPositive() && req.Amount.Amount() < b.MinAmount.Amount() {
		return "", "", errBelowMin
	}
	if b.Category == Airtime && req.Amount.Amount() > maxAirtime {
		return "", "", errAboveMax
	}
	switch {
	case b.RequiresValidation:
		c, err := s.Validate(ctx, b.ID, customerID)
		if err != nil {
			return "", "", err
		}
		customerID = c.ID
	case b.Category == Airtime || b.Category == Data:
		phone, ok := NormalizePhone(customerID)
		if !ok {
			return "", "", errPhone
		}
		customerID = phone
	}
	return customerID, productName, nil
}

// finish asks the biller to deliver a debited payment and records the outcome. It is safe
// to call any number of times: a finished payment is returned as it is, and the biller
// dedupes on the payment's reference.
func (s *Service) finish(ctx context.Context, id uuid.UUID) (billsdb.BillPayment, error) {
	row, err := s.q.GetBillPaymentByID(ctx, id)
	if err != nil {
		return billsdb.BillPayment{}, fmt.Errorf("load payment: %w", err)
	}
	if row.Status != "processing" {
		return row, nil
	}
	vendCtx, cancel := context.WithTimeout(ctx, vendTimeout)
	defer cancel()
	res, vendErr := s.biller.Vend(vendCtx, VendRequest{
		Reference: row.Reference, BillerID: row.BillerID, ProductID: deref(row.ProductID), CustomerID: row.CustomerID,
		Amount: money.New(row.AmountMinor, money.NGN),
	})
	switch {
	case vendErr == nil:
		return s.settle(ctx, id, &res, "")
	case errors.Is(vendErr, ErrVendRejected):
		return s.settle(ctx, id, nil, "biller_rejected")
	default:
		return row, fmt.Errorf("vend: %w", vendErr)
	}
}

// settle records the biller's answer. The payment row is locked first, so two callers
// (the request and the sweep) cannot both complete it or both refund it.
func (s *Service) settle(ctx context.Context, id uuid.UUID, res *VendResult, failure string) (billsdb.BillPayment, error) {
	var out billsdb.BillPayment
	err := pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := billsdb.New(tx)
		row, err := q.LockBillPayment(ctx, id)
		if err != nil {
			return fmt.Errorf("lock payment: %w", err)
		}
		if row.Status != "processing" {
			out = row
			return nil
		}
		now := s.now().UTC()
		if res != nil {
			var token, units *string
			if res.Token != "" {
				token = &res.Token
			}
			if res.Units != "" {
				units = &res.Units
			}
			out, err = q.CompleteBillPayment(ctx, billsdb.CompleteBillPaymentParams{ID: id, Token: token, Units: units, At: &now})
			if err != nil {
				return fmt.Errorf("complete payment: %w", err)
			}
			return nil
		}
		amount := money.New(row.AmountMinor, money.NGN)
		settle, err := ledger.SystemAccount(ctx, tx, ledger.KindPartnerSettlement, string(money.NGN))
		if err != nil {
			return err
		}
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "bill_payment", Reference: row.Reference, IdempotencyKey: "bill_reversal:" + id.String(),
			Metadata: map[string]any{"payment_id": id.String(), "reversal": true, "reason": failure},
			Legs:     []ledger.Leg{ledger.Debit(settle.ID, amount), ledger.Credit(row.AccountID, amount)},
		})
		if err != nil {
			return err
		}
		if _, err := accounts.Record(ctx, tx, accounts.Line{
			UserID: row.UserID, AccountID: row.AccountID, Type: "reversal", Direction: "credit", Status: "completed",
			Amount: amount, Entry: &posted, Narration: "Reversal: " + row.BillerName, Reference: row.Reference,
			Category: categoryOf[row.Category], Counterparty: api.Counterparty{Name: row.BillerName}, At: now,
		}); err != nil {
			return err
		}
		// The refunded amount no longer counts against the day's limit.
		if err := s.limits.Release(ctx, tx, row.UserID, row.LimitDay, amount); err != nil {
			return err
		}
		out, err = q.ReverseBillPayment(ctx, billsdb.ReverseBillPaymentParams{
			ID: id, ReversalEntryID: &posted.EntryID, FailureReason: &failure, At: &now,
		})
		if err != nil {
			return fmt.Errorf("reverse payment: %w", err)
		}
		return nil
	})
	return out, err
}

// SweepStuck finishes payments that were debited but never answered: the process died
// between taking the money and hearing from the biller, or the biller was unreachable.
func (s *Service) SweepStuck(ctx context.Context) (finished int, err error) {
	ids, err := s.q.ListStuckBillPayments(ctx, s.now().Add(-stuckAfter))
	if err != nil {
		return 0, fmt.Errorf("list stuck payments: %w", err)
	}
	for _, id := range ids {
		row, err := s.finish(ctx, id)
		switch {
		case err != nil:
			s.log.Warn("retry bill payment", slog.String("payment_id", id.String()), slog.Any("error", err))
		case row.Status != "processing":
			finished++
		}
	}
	return finished, nil
}

// SweepArgs is the sweep's job.
type SweepArgs struct{}

// Kind implements river.JobArgs.
func (SweepArgs) Kind() string { return "bill_payment_sweep" }

type sweepWorker struct {
	river.WorkerDefaults[SweepArgs]
	s *Service
}

func (w *sweepWorker) Work(ctx context.Context, _ *river.Job[SweepArgs]) error {
	_, err := w.s.SweepStuck(ctx)
	return err
}

// Register adds the bills workers (jobs.Options.Workers).
func (s *Service) Register(w *river.Workers) { river.AddWorker(w, &sweepWorker{s: s}) }

// PeriodicJobs are the bills clocks (jobs.Options.Periodic).
func (s *Service) PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{
		river.NewPeriodicJob(river.PeriodicInterval(5*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return SweepArgs{}, &river.InsertOpts{MaxAttempts: 3} },
			&river.PeriodicJobOpts{RunOnStart: true}),
	}
}

// Get reads one of the caller's payments.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Payment, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return Payment{}, problem.Unauthorized()
	}
	row, err := s.q.GetBillPayment(ctx, billsdb.GetBillPaymentParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Payment{}, ErrPaymentNotFound
	}
	if err != nil {
		return Payment{}, fmt.Errorf("load payment: %w", err)
	}
	return toPayment(row), nil
}

// List returns the caller's payments, newest first.
func (s *Service) List(ctx context.Context, cursor *string, limit *int) ([]Payment, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListBillPayments(ctx, billsdb.ListBillPaymentsParams{
		UserID: p.UserID, AfterID: after.ID, AfterAt: after.Time, RowLimit: int32(n + 1), //nolint:gosec // n <= pagination.MaxLimit
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list payments: %w", err)
	}
	rows, page := pagination.Page(rows, n, func(r billsdb.BillPayment) pagination.Cursor {
		return pagination.Cursor{Time: r.CreatedAt, ID: r.ID}
	})
	out := make([]Payment, len(rows))
	for i, r := range rows {
		out[i] = toPayment(r)
	}
	return out, page, nil
}

func toPayment(r billsdb.BillPayment) Payment {
	return Payment{
		ID: r.ID, Reference: r.Reference, BillerID: r.BillerID, BillerName: r.BillerName, Category: r.Category,
		ProductName: r.ProductName, CustomerID: r.CustomerID, Amount: money.New(r.AmountMinor, money.NGN),
		Fee: money.New(r.FeeMinor, money.NGN), Status: r.Status, Token: r.Token, Units: r.Units,
		TransactionID: r.TransactionID, CreatedAt: r.CreatedAt.UTC(),
	}
}

// reference is the statement reference of a bill payment: BIL plus the payment's random tail.
func reference(id uuid.UUID) string {
	return "BIL-" + strings.ToUpper(strings.ReplaceAll(id.String(), "-", "")[20:])
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
