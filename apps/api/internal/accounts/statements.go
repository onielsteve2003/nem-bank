package accounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/jobs"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// Statement topics. "requested" drives generation; "ready" is the contract's realtime
// event (statement.ready) for the WebSocket hub.
const (
	TopicStatementRequested = "statement.requested"
	TopicStatementReady     = "statement.ready"
)

// MaxStatementMonths is the longest period one statement covers (@nem/shared statement.ts).
const MaxStatementMonths = 12

// DefaultVerifyURL is where a statement's QR code points: the web demo's verification
// page, as in the mock bank, followed by the code.
const DefaultVerifyURL = "https://nem-bank-fodx.vercel.app/verify/"

// snapshotDays is how far back the end-of-day snapshot catches up. The free hosting tier
// sleeps when idle, so one run at midnight could be missed; an hourly run that fills any
// gap in the last week cannot.
const snapshotDays = 7

// snapshotSettle is how long after midnight a day is snapshotted, so a transaction that
// wrote a posting just before midnight has committed (writes time out after 30 s).
const snapshotSettle = 5 * time.Minute

// ErrStatementNotFound is the 404 for a statement the caller cannot see or a code that
// matches no issued statement.
var ErrStatementNotFound = problem.NotFound("Statement")

// errStatementNotReady matches the mock bank's 409 for a download before generation ends.
var errStatementNotReady = problem.New(http.StatusConflict, "statement_not_ready", "Still generating")

// Statement is a statement without its PDF.
type Statement = accountsdb.GetStatementRow

// StatementRangeError says why a period cannot have a statement, or "" when it can. All
// dates are Lagos calendar days; it ports @nem/shared statementRangeError.
func StatementRangeError(from, to, today time.Time) string {
	switch {
	case from.After(to):
		return "The start date is after the end date"
	case to.After(today):
		return "Statements cannot cover future dates"
	case !from.After(addMonths(to, -MaxStatementMonths)):
		return fmt.Sprintf("A statement covers up to %d months", MaxStatementMonths)
	}
	return ""
}

// addMonths is the same day n months away; a day past the month's end clamps to its last
// day (31 March − 1 month = 28 or 29 February), as addMonthsIso does.
func addMonths(d time.Time, n int) time.Time {
	first := time.Date(d.Year(), d.Month()+time.Month(n), 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	return time.Date(first.Year(), first.Month(), min(d.Day(), last), 0, 0, 0, 0, time.UTC)
}

func civil(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func pgDate(t time.Time) pgtype.Date { return pgtype.Date{Time: civil(t), Valid: true} }

// RequestStatement starts generating a statement of the caller's account for [from, to].
func (s *Service) RequestStatement(ctx context.Context, account uuid.UUID, from, to time.Time) (Statement, error) {
	p, err := principal(ctx)
	if err != nil {
		return Statement{}, err
	}
	acc, err := s.own(ctx, p.UserID, account)
	if err != nil {
		return Statement{}, err
	}
	if msg := StatementRangeError(civil(from), civil(to), civil(s.now().In(lagos))); msg != "" {
		return Statement{}, problem.Validation(problem.Field("/from", "invalid_period", msg))
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Statement{}, fmt.Errorf("statement id: %w", err)
	}
	var st Statement
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		row, err := s.q.WithTx(tx).InsertStatement(ctx, accountsdb.InsertStatementParams{
			ID: id, UserID: p.UserID, AccountID: account, Currency: acc.Currency,
			PeriodFrom: pgDate(from), PeriodTo: pgDate(to),
		})
		if err != nil {
			return fmt.Errorf("insert statement: %w", err)
		}
		st = Statement(row)
		_, err = jobs.Write(ctx, tx, jobs.Event{
			Topic: TopicStatementRequested, AggregateType: "statement", AggregateID: id.String(),
			Payload: map[string]string{"statement_id": id.String()},
		})
		return err
	})
	if err != nil {
		return Statement{}, err
	}
	return st, nil
}

// Statements pages through the caller's statements, newest first.
func (s *Service) Statements(ctx context.Context, cursor *string, limit *int) ([]Statement, api.PageInfo, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	after, err := pagination.Decode(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	rows, err := s.q.ListStatements(ctx, accountsdb.ListStatementsParams{
		UserID: p.UserID, AfterID: after.ID, AfterAt: after.Time, Lim: int32(n + 1), //nolint:gosec // n ≤ pagination.MaxLimit
	})
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list statements: %w", err)
	}
	out := make([]Statement, len(rows))
	for i, r := range rows {
		out[i] = Statement(r)
	}
	items, page := pagination.Page(out, n, func(st Statement) pagination.Cursor {
		return pagination.Cursor{Time: st.CreatedAt, ID: st.ID}
	})
	return items, page, nil
}

// Statement returns one of the caller's statements.
func (s *Service) Statement(ctx context.Context, id uuid.UUID) (Statement, error) {
	p, err := principal(ctx)
	if err != nil {
		return Statement{}, err
	}
	st, err := s.q.GetStatement(ctx, accountsdb.GetStatementParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Statement{}, ErrStatementNotFound
	}
	if err != nil {
		return Statement{}, fmt.Errorf("load statement: %w", err)
	}
	return st, nil
}

// StatementPDF returns the issued PDF of a ready statement.
func (s *Service) StatementPDF(ctx context.Context, id uuid.UUID) ([]byte, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	r, err := s.q.GetStatementPDF(ctx, accountsdb.GetStatementPDFParams{ID: id, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrStatementNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load statement pdf: %w", err)
	}
	if r.Status != "ready" {
		return nil, errStatementNotReady
	}
	return r.Pdf, nil
}

// Verification is what the public verification page shows: masked, so the link is safe
// to hand to an embassy.
type Verification struct {
	NameMasked, NumberMasked string
	Currency                 string
	From, To                 time.Time
	SHA256                   string
	IssuedAt                 time.Time
}

// VerifyStatement looks a statement up by the code printed on it. Unknown codes are 404.
func (s *Service) VerifyStatement(ctx context.Context, code string) (Verification, error) {
	r, err := s.q.GetStatementByCode(ctx, &code)
	if errors.Is(err, pgx.ErrNoRows) {
		return Verification{}, ErrStatementNotFound
	}
	if err != nil {
		return Verification{}, fmt.Errorf("load statement: %w", err)
	}
	prof, err := s.customers.CustomerProfile(ctx, r.UserID)
	if err != nil {
		return Verification{}, err
	}
	return Verification{
		NameMasked: MaskName(prof.Name), NumberMasked: MaskNumber(r.AccountNumber), Currency: r.Currency,
		From: r.PeriodFrom.Time, To: r.PeriodTo.Time, SHA256: deref(r.Sha256), IssuedAt: deref(r.ReadyAt),
	}, nil
}

// MaskName keeps each word's first letter: "Tolu Adeyemi" → "T*** A******".
func MaskName(name string) string {
	words := strings.Fields(name)
	for i, w := range words {
		r := []rune(w)
		words[i] = string(r[0]) + strings.Repeat("*", len(r)-1)
	}
	return strings.Join(words, " ")
}

// MaskNumber shows only the last four digits, as the mock bank's maskAccount.
func MaskNumber(n string) string {
	if len(n) <= 4 {
		return n
	}
	return strings.Repeat("*", len(n)-4) + n[len(n)-4:]
}

// statementLine is one posting on the statement.
type statementLine struct {
	At           time.Time
	EntryID      uuid.UUID
	Narration    string
	Reference    string
	Amount       int64 // signed: credits positive
	BalanceAfter int64
}

// statementDoc is everything printed on a statement.
type statementDoc struct {
	ID                uuid.UUID
	AccountName       string
	AccountNumber     string
	Currency          string
	From, To          time.Time
	Opening, Closing  int64
	MoneyIn, MoneyOut int64
	Lines             []statementLine
	IssuedAt          time.Time
	SHA256, Code, URL string
}

// contentHash is the SHA-256 of the statement's canonical text: every figure and line,
// one per row, in a fixed format. Printing the hash of the PDF inside the PDF is
// impossible (it would change the hash), so the hash covers what the PDF says instead.
func contentHash(d statementDoc) string {
	var b strings.Builder
	fmt.Fprintf(&b, "nem-statement-v1\nid %s\naccount %s %s\nperiod %s %s\nopening %d\nclosing %d\n",
		d.ID, d.AccountNumber, d.Currency, d.From.Format(time.DateOnly), d.To.Format(time.DateOnly), d.Opening, d.Closing)
	for _, l := range d.Lines {
		fmt.Fprintf(&b, "%s|%s|%d|%d|%s|%s\n", l.At.UTC().Format(time.RFC3339Nano), l.EntryID, l.Amount, l.BalanceAfter, l.Reference, l.Narration)
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

// errStatementDrift means the postings in the period do not lead from the opening to the
// closing balance. It cannot happen while every write goes through the posting engine;
// if it ever does, no statement is issued rather than a wrong one.
var errStatementDrift = errors.New("accounts: statement postings do not add up to the closing balance")

// GenerateStatement builds and issues a requested statement. It is idempotent: a
// statement that is no longer generating is left alone, so a redelivered job is harmless.
func (s *Service) GenerateStatement(ctx context.Context, id uuid.UUID) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		st, err := q.LockStatement(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return river.JobCancel(fmt.Errorf("statement %s does not exist", id))
		}
		if err != nil {
			return fmt.Errorf("lock statement: %w", err)
		}
		if st.Status != "generating" {
			return nil
		}
		doc, err := s.buildStatement(ctx, tx, st)
		if err != nil {
			return err
		}
		pdf, err := renderStatement(doc)
		if err != nil {
			// Rendering is deterministic: retrying would fail the same way.
			s.log.ErrorContext(ctx, "render statement", "statement_id", id.String(), "error", err.Error())
			if err := q.FailStatement(ctx, id); err != nil {
				return fmt.Errorf("fail statement: %w", err)
			}
			return nil
		}
		if err := q.CompleteStatement(ctx, accountsdb.CompleteStatementParams{
			ID: id, OpeningBalanceMinor: &doc.Opening, ClosingBalanceMinor: &doc.Closing,
			Sha256: &doc.SHA256, VerificationCode: &doc.Code, Pdf: pdf,
		}); err != nil {
			return fmt.Errorf("complete statement: %w", err)
		}
		ready, err := q.GetStatement(ctx, accountsdb.GetStatementParams{ID: id, UserID: st.UserID})
		if err != nil {
			return fmt.Errorf("reload statement: %w", err)
		}
		body, err := json.Marshal(s.StatementJSON(ready))
		if err != nil {
			return fmt.Errorf("statement event: %w", err)
		}
		_, err = jobs.Write(ctx, tx, jobs.Event{
			Topic: TopicStatementReady, AggregateType: "statement", AggregateID: id.String(),
			Payload: map[string]any{"user_id": st.UserID, "statement": json.RawMessage(body)},
		})
		return err
	})
}

func (s *Service) buildStatement(ctx context.Context, tx pgx.Tx, st accountsdb.LockStatementRow) (statementDoc, error) {
	acc, err := s.own(ctx, st.UserID, st.AccountID)
	if err != nil {
		return statementDoc{}, err
	}
	prof, err := s.customers.CustomerProfile(ctx, st.UserID)
	if err != nil {
		return statementDoc{}, err
	}
	since := lagosMidnight(st.PeriodFrom.Time)
	until := lagosMidnight(st.PeriodTo.Time).AddDate(0, 0, 1)
	opening, err := ledger.BalancesBefore(ctx, tx, []uuid.UUID{st.AccountID}, since)
	if err != nil {
		return statementDoc{}, err
	}
	postings, err := ledger.AccountPostings(ctx, tx, st.AccountID, since, until)
	if err != nil {
		return statementDoc{}, err
	}
	entries := make([]uuid.UUID, len(postings))
	for i, p := range postings {
		entries[i] = p.EntryID
	}
	lines, err := s.q.WithTx(tx).ListLinesForEntries(ctx, accountsdb.ListLinesForEntriesParams{AccountID: st.AccountID, EntryIds: entries})
	if err != nil {
		return statementDoc{}, fmt.Errorf("statement narrations: %w", err)
	}
	narration := make(map[uuid.UUID]accountsdb.ListLinesForEntriesRow, len(lines))
	for _, l := range lines {
		narration[*l.EntryID] = l
	}

	doc := statementDoc{
		ID: st.ID, AccountName: prof.Name, AccountNumber: acc.AccountNumber, Currency: st.Currency,
		From: st.PeriodFrom.Time, To: st.PeriodTo.Time, Opening: opening[st.AccountID], IssuedAt: s.now().UTC(),
	}
	running := doc.Opening
	for _, p := range postings {
		l := statementLine{At: p.CreatedAt, EntryID: p.EntryID, Amount: p.AmountMinor, BalanceAfter: p.BalanceAfterMinor,
			Narration: strings.ReplaceAll(p.EntryKind, "_", " "), Reference: p.EntryReference}
		if t, ok := narration[p.EntryID]; ok {
			l.Narration, l.Reference = t.Narration, t.Reference
		}
		running += p.AmountMinor // bounded by the ledger's own overflow-checked balances
		if running != p.BalanceAfterMinor {
			return statementDoc{}, fmt.Errorf("%w: %s", errStatementDrift, st.ID)
		}
		if p.AmountMinor > 0 {
			doc.MoneyIn += p.AmountMinor
		} else {
			doc.MoneyOut -= p.AmountMinor
		}
		doc.Lines = append(doc.Lines, l)
	}
	doc.Closing = running
	doc.SHA256 = contentHash(doc)
	doc.Code = strings.ToUpper(doc.SHA256[:12])
	doc.URL = s.verifyURL + doc.Code
	return doc, nil
}

// StatementJSON is the contract's Statement.
func (s *Service) StatementJSON(st Statement) api.Statement {
	out := api.Statement{
		Id: st.ID, AccountId: st.AccountID, Currency: api.CurrencyCode(st.Currency),
		PeriodFrom: api.Date{Time: st.PeriodFrom.Time}, PeriodTo: api.Date{Time: st.PeriodTo.Time},
		Status: api.StatementStatus(st.Status), Sha256: st.Sha256, VerificationCode: st.VerificationCode,
		CreatedAt: st.CreatedAt.UTC(),
	}
	if st.OpeningBalanceMinor != nil {
		m := minor(*st.OpeningBalanceMinor, st.Currency)
		out.OpeningBalance = &m
	}
	if st.ClosingBalanceMinor != nil {
		m := minor(*st.ClosingBalanceMinor, st.Currency)
		out.ClosingBalance = &m
	}
	if st.VerificationCode != nil {
		u := s.verifyURL + *st.VerificationCode
		out.VerificationUrl = &u
	}
	return out
}

// StatementSubscriber generates statements as their requests leave the outbox.
func (s *Service) StatementSubscriber() jobs.Subscriber {
	return jobs.Subscriber{
		Name: "statements.generate", Topics: []string{TopicStatementRequested},
		Handle: func(ctx context.Context, d jobs.Delivery) error {
			id, err := uuid.Parse(d.AggregateID)
			if err != nil {
				return river.JobCancel(fmt.Errorf("statement id %q: %w", d.AggregateID, err))
			}
			return s.GenerateStatement(ctx, id)
		},
	}
}

// SnapshotBalances records every customer account's end-of-day balance for each Lagos
// day of the last week that has ended (and settled) and has no snapshot yet. It is safe
// to run as often as wanted: each (account, day) is written once.
func (s *Service) SnapshotBalances(ctx context.Context) error {
	today := civil(s.now().Add(-snapshotSettle).In(lagos))
	for back := snapshotDays; back >= 1; back-- {
		day := today.AddDate(0, 0, -back)
		end := lagosMidnight(day).AddDate(0, 0, 1)
		ids, err := s.q.AccountsWithoutSnapshot(ctx, accountsdb.AccountsWithoutSnapshotParams{DayEnd: end, AsOf: pgDate(day)})
		if err != nil {
			return fmt.Errorf("accounts to snapshot: %w", err)
		}
		if len(ids) == 0 {
			continue
		}
		bal, err := ledger.BalancesBefore(ctx, s.pool, ids, end)
		if err != nil {
			return err
		}
		balances := make([]int64, len(ids))
		for i, id := range ids {
			balances[i] = bal[id]
		}
		if err := s.q.InsertDailyBalances(ctx, accountsdb.InsertDailyBalancesParams{
			AccountIds: ids, AsOf: pgDate(day), Balances: balances,
		}); err != nil {
			return fmt.Errorf("insert daily balances: %w", err)
		}
	}
	return nil
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

// formatAmount prints minor units as major units with thousands separators: 123456 →
// "1,234.56". Statements avoid currency symbols such as ₦ that PDF core fonts lack.
func formatAmount(minorUnits int64) string {
	neg := minorUnits < 0
	u := uint64(minorUnits) //nolint:gosec // two's complement: negated below for negatives
	if neg {
		u = -u
	}
	whole, frac := u/100, u%100
	digits := strconv.FormatUint(whole, 10)
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	for i, c := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	fmt.Fprintf(&b, ".%02d", frac)
	return b.String()
}
