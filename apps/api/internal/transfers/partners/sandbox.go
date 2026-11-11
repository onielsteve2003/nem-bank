package partners

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners/partnersdb"
)

// AccountName is a name enquiry's answer: the name the receiving bank holds.
type AccountName struct {
	BankCode      string
	AccountNumber string
	Name          string
	// NameCheck overrides Confirmation of Payee in the sandbox; Realistic compares names.
	NameCheck NameCheck
}

// SandboxConfig holds the sandbox rail's dependencies.
type SandboxConfig struct {
	// Pool stores payments and settings. Nil gives a name-enquiry-only sandbox with the
	// default settings (unit tests that never send).
	Pool *pgxpool.Pool
	// CallbackURL receives the signed status callbacks, normally this API's own
	// /v1/partner-webhooks/sandbox_nip. Empty sends none: the saga then learns outcomes
	// by status query alone, as it must with partners that never call back.
	CallbackURL string
	// Secret signs callbacks; the inbound webhook verifies with the same one.
	Secret []byte
	// HTTP delivers callbacks; nil gets a client with a 10-second timeout.
	HTTP   *http.Client
	Logger *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// SandboxNIP simulates the NIBSS Instant Payment rail: payments settle or fail after the
// simulator's delay, some time out and never answer, and each final answer is sent back
// as a signed callback by a River job, so it survives a restart like a real partner's.
type SandboxNIP struct {
	pool   *pgxpool.Pool
	insert *river.Client[pgx.Tx]
	url    string
	secret []byte
	http   *http.Client
	log    *slog.Logger
	now    func() time.Time
}

var _ BankPartner = (*SandboxNIP)(nil)

// NewSandboxNIP returns the sandbox rail.
func NewSandboxNIP(cfg SandboxConfig) (*SandboxNIP, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.HTTP == nil {
		cfg.HTTP = &http.Client{Timeout: 10 * time.Second}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.DiscardHandler)
	}
	if cfg.CallbackURL != "" && len(cfg.Secret) == 0 {
		return nil, errors.New("partners: sandbox callbacks need a signing secret")
	}
	s := &SandboxNIP{pool: cfg.Pool, url: cfg.CallbackURL, secret: cfg.Secret, http: cfg.HTTP, log: cfg.Logger, now: cfg.Now}
	if cfg.Pool != nil {
		// Insert-only: the process's jobs.Runner works the callbacks (Register).
		c, err := river.NewClient(riverpgxv5.New(cfg.Pool), &river.Config{Logger: cfg.Logger})
		if err != nil {
			return nil, fmt.Errorf("sandbox job client: %w", err)
		}
		s.insert = c
	}
	return s, nil
}

// Name identifies the partner in logs, callbacks and the ledger.
func (*SandboxNIP) Name() string { return "sandbox_nip" }

// NameEnquiry asks the receiving bank whose account this is (NIP name enquiry).
func (s *SandboxNIP) NameEnquiry(ctx context.Context, bankCode, accountNumber string) (AccountName, error) {
	if _, ok := BankByCode(bankCode); !ok || bankCode == NemBankCode {
		return AccountName{}, fmt.Errorf("%w: bank %s", ErrAccountNotFound, bankCode)
	}
	name, err := sandboxAccountName(accountNumber)
	if err != nil {
		return AccountName{}, err
	}
	set, err := s.Settings(ctx)
	if err != nil {
		return AccountName{}, err
	}
	return AccountName{BankCode: bankCode, AccountNumber: accountNumber, Name: name, NameCheck: set.NameCheck}, nil
}

// failureCodes are NIP response codes a receiving bank answers with.
var failureCodes = []string{
	"57", // transaction not permitted to the beneficiary
	"91", // beneficiary bank not available
	"96", // system malfunction at the beneficiary bank
}

// Send accepts a payment and draws its fate from the simulator's settings. A resend of
// the same reference returns the first submission and draws nothing.
func (s *SandboxNIP) Send(ctx context.Context, p Payment) (Submission, error) {
	if s.pool == nil {
		return Submission{}, errors.New("partners: the sandbox needs a database to send")
	}
	if p.Amount.Currency() != money.NGN || !p.Amount.IsPositive() {
		return Submission{}, fmt.Errorf("%w: NIP carries positive naira amounts only", ErrRejected)
	}
	if _, err := s.NameEnquiry(ctx, p.BankCode, p.AccountNumber); err != nil {
		return Submission{}, err
	}
	set, err := s.Settings(ctx)
	if err != nil {
		return Submission{}, err
	}
	outcome, code := "settled", (*string)(nil)
	switch roll := draw(10_000); {
	case roll < set.FailureRateBps:
		outcome, code = "failed", &failureCodes[draw(len(failureCodes))]
	case roll < set.FailureRateBps+set.TimeoutRateBps:
		outcome = "timeout"
	}
	now := s.now().UTC()
	delay := set.MinDelaySeconds + draw(set.MaxDelaySeconds-set.MinDelaySeconds+1)
	session, err := sessionID(now)
	if err != nil {
		return Submission{}, err
	}

	var sub Submission
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := partnersdb.New(tx)
		row, err := q.InsertSandboxPayment(ctx, partnersdb.InsertSandboxPaymentParams{
			Reference: p.Reference, PartnerReference: session, BankCode: p.BankCode, AccountNumber: p.AccountNumber,
			Currency: string(p.Amount.Currency()), AmountMinor: p.Amount.Amount(), Outcome: outcome, FailureCode: code,
			ReceivedAt: now, SettleAt: now.Add(time.Duration(delay) * time.Second),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			// Seen before: the first submission stands.
			prev, err := q.GetSandboxPayment(ctx, p.Reference)
			if err != nil {
				return fmt.Errorf("load sandbox payment: %w", err)
			}
			sub = Submission{PartnerReference: prev.PartnerReference}
			return nil
		}
		if err != nil {
			return fmt.Errorf("insert sandbox payment: %w", err)
		}
		sub = Submission{PartnerReference: row.PartnerReference}
		if outcome == "timeout" || s.url == "" {
			return nil
		}
		_, err = s.insert.InsertTx(ctx, tx, CallbackArgs{Reference: p.Reference}, &river.InsertOpts{ScheduledAt: row.SettleAt})
		if err != nil {
			return fmt.Errorf("schedule sandbox callback: %w", err)
		}
		return nil
	})
	return sub, err
}

// Status answers a status query. The outcome only shows once its delay has passed, so it
// always agrees with the callback; a timed-out payment stays pending for ever.
func (s *SandboxNIP) Status(ctx context.Context, reference string) (Result, error) {
	if s.pool == nil {
		return Result{State: Unknown}, nil
	}
	row, err := partnersdb.New(s.pool).GetSandboxPayment(ctx, reference)
	if errors.Is(err, pgx.ErrNoRows) {
		return Result{State: Unknown}, nil
	}
	if err != nil {
		return Result{}, fmt.Errorf("load sandbox payment: %w", err)
	}
	return result(row, s.now()), nil
}

func result(row partnersdb.SandboxNipPayment, now time.Time) Result {
	r := Result{State: Pending, PartnerReference: row.PartnerReference, At: row.ReceivedAt}
	if row.Outcome == "timeout" || now.Before(row.SettleAt) {
		return r
	}
	r.State, r.At = State(row.Outcome), row.SettleAt
	if row.FailureCode != nil {
		r.FailureCode = *row.FailureCode
	}
	return r
}

// CallbackArgs is the River job that tells Nem a sandbox payment's outcome.
type CallbackArgs struct {
	Reference string `json:"reference" river:"unique"`
}

// Kind implements river.JobArgs.
func (CallbackArgs) Kind() string { return "sandbox_nip_callback" }

// InsertOpts implements river.JobArgsWithInsertOpts: one callback job per payment.
func (CallbackArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

type callbackWorker struct {
	river.WorkerDefaults[CallbackArgs]
	s *SandboxNIP
}

func (w *callbackWorker) Work(ctx context.Context, job *river.Job[CallbackArgs]) error {
	return w.s.DeliverCallback(ctx, job.Args.Reference)
}

// Register adds the callback worker to the process's River workers (jobs.Options.Workers).
func (s *SandboxNIP) Register(w *river.Workers) { river.AddWorker(w, &callbackWorker{s: s}) }

// DeliverCallback posts a payment's final outcome to CallbackURL, signed. A non-2xx answer
// is an error, so River retries with backoff; the event ID stays the same on every try,
// so the receiver can drop repeats.
func (s *SandboxNIP) DeliverCallback(ctx context.Context, reference string) error {
	row, err := partnersdb.New(s.pool).GetSandboxPayment(ctx, reference)
	if err != nil {
		return fmt.Errorf("load sandbox payment: %w", err)
	}
	r := result(row, s.now())
	if row.Outcome == "timeout" || row.CallbackSentAt != nil || s.url == "" {
		return nil
	}
	if !r.State.Final() {
		// Woken a moment early (the job clock is the database's): try again at settle time.
		return river.JobSnooze(max(row.SettleAt.Sub(s.now()), time.Second))
	}
	event := api.PartnerCallbackEventTypeTransferSettled
	if r.State == Failed {
		event = api.PartnerCallbackEventTypeTransferFailed
	}
	number := row.AccountNumber
	body, err := json.Marshal(api.PartnerCallback{
		EventType: event, Reference: row.Reference, OccurredAt: r.At.UTC(), AccountNumber: &number,
		Amount:      &api.Money{AmountMinor: strconv.FormatInt(row.AmountMinor, 10), Currency: api.CurrencyCode(row.Currency)},
		FailureCode: row.FailureCode,
		Payload:     &map[string]any{"session_id": row.PartnerReference},
	})
	if err != nil {
		return fmt.Errorf("encode callback: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("callback request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Partner-Signature", Sign(s.secret, s.now(), body))
	req.Header.Set("Partner-Event-Id", row.PartnerReference+":"+string(r.State))
	resp, err := s.http.Do(req) //nolint:gosec // the URL is our own configured callback endpoint, not caller input
	if err != nil {
		return fmt.Errorf("deliver callback: %w", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("deliver callback: receiver answered %d", resp.StatusCode)
	}
	if err := partnersdb.New(s.pool).MarkSandboxCallbackSent(ctx, reference); err != nil {
		return fmt.Errorf("mark callback sent: %w", err)
	}
	return nil
}

// sessionID looks like a NIP session ID: a sender code, the time and random digits.
func sessionID(now time.Time) (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000_000_000))
	if err != nil {
		return "", fmt.Errorf("session id: %w", err)
	}
	return fmt.Sprintf("090999%s%012d", now.Format("060102150405"), n), nil
}

// draw is a uniform integer in [0, n). The sandbox's dice need no secrecy, but crypto/rand
// keeps gosec quiet and costs nothing at this rate.
func draw(n int) int {
	if n <= 1 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return 0
	}
	return int(v.Int64())
}

// SettlementReport is the sandbox's settlement file for [from, to).
func (s *SandboxNIP) SettlementReport(ctx context.Context, from, to time.Time) ([]Settlement, error) {
	if s.pool == nil {
		return nil, nil
	}
	rows, err := partnersdb.New(s.pool).ListSettledSandboxPayments(ctx, partnersdb.ListSettledSandboxPaymentsParams{FromAt: from, ToAt: to})
	if err != nil {
		return nil, fmt.Errorf("list settled sandbox payments: %w", err)
	}
	out := make([]Settlement, len(rows))
	for i, r := range rows {
		out[i] = Settlement{Reference: r.Reference, Amount: money.New(r.AmountMinor, money.Currency(r.Currency)), SettledAt: r.SettleAt}
	}
	return out, nil
}
