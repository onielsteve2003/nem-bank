package accounts

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func day(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

// The vectors of @nem/shared statement.test.ts, so app and API agree on every period.
func TestStatementPeriodsMatchTheSharedRules(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		from   string
		months int
		want   string
	}{
		{"2026-03-31", -1, "2026-02-28"}, {"2024-03-31", -1, "2024-02-29"},
		{"2026-01-15", -12, "2025-01-15"}, {"2026-11-30", 2, "2027-01-30"},
	} {
		if got := addMonths(day(tc.from), tc.months).Format(time.DateOnly); got != tc.want {
			t.Errorf("addMonths(%s, %d) = %s, want %s", tc.from, tc.months, got, tc.want)
		}
	}
	for _, tc := range []struct{ from, to, today, want string }{
		{"2025-10-21", "2026-10-20", "2026-10-20", ""},
		{"2026-10-20", "2026-10-20", "2026-10-20", ""},
		{"2026-10-02", "2026-10-01", "2026-10-20", "The start date is after the end date"},
		{"2026-10-01", "2026-10-21", "2026-10-20", "Statements cannot cover future dates"},
		{"2025-10-20", "2026-10-20", "2026-10-20", "A statement covers up to 12 months"},
	} {
		if got := StatementRangeError(day(tc.from), day(tc.to), day(tc.today)); got != tc.want {
			t.Errorf("StatementRangeError(%s, %s, %s) = %q, want %q", tc.from, tc.to, tc.today, got, tc.want)
		}
	}
}

func TestMasksAndAmounts(t *testing.T) {
	t.Parallel()
	if got := MaskName("Tolu Adeyemi"); got != "T*** A******" {
		t.Errorf("MaskName = %q", got)
	}
	if got := MaskNumber("1000000007"); got != "******0007" {
		t.Errorf("MaskNumber = %q", got)
	}
	for in, want := range map[int64]string{0: "0.00", 5: "0.05", 123456: "1,234.56", -100000000: "-1,000,000.00", 99999: "999.99"} {
		if got := formatAmount(in); got != want {
			t.Errorf("formatAmount(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestTheHashCoversEveryFigure(t *testing.T) {
	t.Parallel()
	d := statementDoc{
		ID: uuid.New(), AccountNumber: "1000000007", Currency: "NGN", From: day("2026-11-01"), To: day("2026-11-09"),
		Opening: 100, Closing: 300, Lines: []statementLine{{EntryID: uuid.New(), Amount: 200, BalanceAfter: 300, Narration: "Gift"}},
	}
	base := contentHash(d)
	tampered := d
	tampered.Lines = []statementLine{{EntryID: d.Lines[0].EntryID, Amount: 200, BalanceAfter: 300, Narration: "Gift!"}}
	if contentHash(tampered) == base {
		t.Fatal("changing a narration kept the hash")
	}
	tampered = d
	tampered.Closing = 301
	if contentHash(tampered) == base {
		t.Fatal("changing the closing balance kept the hash")
	}
}

func TestStatementsAreGeneratedVerifiedAndDownloaded(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	accs, err := f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	acct := accs[0].AccountID
	now := time.Now()
	f.fund(user, acct, ngn(5_000_000), "Salary for October", now)
	f.fund(user, acct, ngn(250_000), "Gift from Ada", now)

	today := civil(now.In(lagos))
	tomorrow := today.AddDate(0, 0, 1)
	// The clock moves two days on, so a period after today has an opening balance and no lines.
	f.svc.now = func() time.Time { return now.Add(48 * time.Hour) }

	var bad *problem.Error
	if _, err := f.svc.RequestStatement(ctx, acct, today, tomorrow.AddDate(0, 0, 5)); !errors.As(err, &bad) || bad.Status != 400 {
		t.Fatalf("future period: %v", err)
	}
	other, _ := f.customer()
	if _, err := f.svc.RequestStatement(other, acct, today, today); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("other customer's account: %v", err)
	}

	st, err := f.svc.RequestStatement(ctx, acct, today, tomorrow)
	if err != nil {
		t.Fatal(err)
	}
	if st.Status != "generating" || st.Sha256 != nil {
		t.Fatalf("requested = %+v", st)
	}
	countEvents := func(topic string) int {
		t.Helper()
		var n int
		if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM outbox_events WHERE topic = $1`, topic).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := countEvents(TopicStatementRequested); n != 1 {
		t.Fatalf("requested events = %d", n)
	}
	if _, err := f.svc.StatementPDF(ctx, st.ID); !errors.Is(err, errStatementNotReady) {
		t.Fatalf("download while generating: %v", err)
	}

	if err := f.svc.GenerateStatement(t.Context(), st.ID); err != nil {
		t.Fatal(err)
	}
	ready, err := f.svc.Statement(ctx, st.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ready.Status != "ready" || *ready.OpeningBalanceMinor != 0 || *ready.ClosingBalanceMinor != 5_250_000 ||
		*ready.VerificationCode != strings.ToUpper((*ready.Sha256)[:12]) {
		t.Fatalf("ready = %+v", ready)
	}
	if j := f.svc.StatementJSON(ready); j.VerificationUrl == nil || *j.VerificationUrl != DefaultVerifyURL+*ready.VerificationCode {
		t.Fatalf("json = %+v", j)
	}
	if n := countEvents(TopicStatementReady); n != 1 {
		t.Fatalf("ready events = %d", n)
	}

	pdf, err := f.svc.StatementPDF(ctx, st.ID)
	if err != nil || !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		t.Fatalf("pdf = %d bytes, %v", len(pdf), err)
	}
	if _, err := f.svc.StatementPDF(other, st.ID); !errors.Is(err, ErrStatementNotFound) {
		t.Fatalf("other customer's pdf: %v", err)
	}
	// A redelivered job leaves the issued statement alone.
	if err := f.svc.GenerateStatement(t.Context(), st.ID); err != nil {
		t.Fatal(err)
	}
	if again, _ := f.svc.StatementPDF(ctx, st.ID); !bytes.Equal(again, pdf) || countEvents(TopicStatementReady) != 1 {
		t.Fatal("a second run changed the issued statement")
	}

	v, err := f.svc.VerifyStatement(t.Context(), *ready.VerificationCode)
	if err != nil || v.NameMasked != "T*** A******" || v.NumberMasked != MaskNumber(accs[0].AccountNumber) || v.SHA256 != *ready.Sha256 {
		t.Fatalf("verification = %+v, %v", v, err)
	}
	if _, err := f.svc.VerifyStatement(t.Context(), "ABCDEF123456"); !errors.Is(err, ErrStatementNotFound) {
		t.Fatalf("unknown code: %v", err)
	}

	// The day after: the whole balance is the opening and nothing moved.
	later, err := f.svc.RequestStatement(ctx, acct, tomorrow, tomorrow)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.svc.GenerateStatement(t.Context(), later.ID); err != nil {
		t.Fatal(err)
	}
	if l, err := f.svc.Statement(ctx, later.ID); err != nil || *l.OpeningBalanceMinor != 5_250_000 || *l.ClosingBalanceMinor != 5_250_000 {
		t.Fatalf("later = %+v, %v", l, err)
	}

	list, page, err := f.svc.Statements(ctx, nil, nil)
	if err != nil || len(list) != 2 || list[0].ID != later.ID || page.NextCursor != nil {
		t.Fatalf("list = %+v, %v", list, err)
	}
}

func TestEndOfDayBalancesAreSnapshottedOnce(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	ctx, user := f.customer()
	accs, err := f.svc.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	acct := accs[0].AccountID
	now := time.Now()
	f.fund(user, acct, ngn(700_000), "Salary", now)
	today := civil(now.In(lagos))
	f.svc.now = func() time.Time { return now.Add(48 * time.Hour) }
	for range 2 { // a second run changes nothing
		if err := f.svc.SnapshotBalances(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := f.pool.Query(t.Context(), `SELECT as_of, balance_minor FROM daily_balances WHERE account_id = $1`, acct)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]int64{}
	for rows.Next() {
		var d time.Time
		var b int64
		if err := rows.Scan(&d, &b); err != nil {
			t.Fatal(err)
		}
		got[d.Format(time.DateOnly)] = b
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	// The account opened today: today and tomorrow are snapshotted, nothing before.
	want := map[string]int64{today.Format(time.DateOnly): 700_000, today.AddDate(0, 0, 1).Format(time.DateOnly): 700_000}
	if len(got) != len(want) || got[today.Format(time.DateOnly)] != 700_000 || got[today.AddDate(0, 0, 1).Format(time.DateOnly)] != 700_000 {
		t.Fatalf("snapshots = %v, want %v", got, want)
	}
}
