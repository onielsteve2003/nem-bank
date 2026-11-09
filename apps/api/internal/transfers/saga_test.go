package transfers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
)

// fakePartner is a bank partner the test answers for.
type fakePartner struct {
	mu      sync.Mutex
	sends   map[string]int
	answers map[string]partners.Result
	sendErr error
}

func newFakePartner() *fakePartner {
	return &fakePartner{sends: map[string]int{}, answers: map[string]partners.Result{}}
}

func (*fakePartner) Name() string { return "fake" }

func (*fakePartner) NameEnquiry(_ context.Context, bank, number string) (partners.AccountName, error) {
	if strings.HasSuffix(number, "0000") {
		return partners.AccountName{}, partners.ErrAccountNotFound
	}
	return partners.AccountName{BankCode: bank, AccountNumber: number, Name: "Chidi Okonkwo"}, nil
}

func (p *fakePartner) Send(_ context.Context, pay partners.Payment) (partners.Submission, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sendErr != nil {
		return partners.Submission{}, p.sendErr
	}
	p.sends[pay.Reference]++
	return partners.Submission{PartnerReference: "S-" + pay.Reference}, nil
}

func (p *fakePartner) Status(_ context.Context, ref string) (partners.Result, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if r, ok := p.answers[ref]; ok {
		return r, nil
	}
	if p.sends[ref] > 0 {
		return partners.Result{State: partners.Pending}, nil
	}
	return partners.Result{State: partners.Unknown}, nil
}

func (p *fakePartner) answer(ref string, r partners.Result) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.answers[ref] = r
}

type sagaFixture struct {
	*fixture
	partner *fakePartner
	tolu    customer
	clock   time.Time
	mu      sync.Mutex
}

func (s *sagaFixture) now() time.Time { s.mu.Lock(); defer s.mu.Unlock(); return s.clock }
func (s *sagaFixture) advance(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clock = s.clock.Add(d)
}

func newSaga(t *testing.T) *sagaFixture {
	t.Helper()
	s := &sagaFixture{partner: newFakePartner(), clock: time.Now()}
	s.fixture = newFixtureWith(t, func(c *Config) {
		c.Partner, c.Now, c.WebhookSecrets = s.partner, s.now, map[string][]byte{"fake": []byte("fake-secret")}
	})
	s.tolu = s.customer("Tolu", "tolu", 5_000_000)
	return s
}

func (s *sagaFixture) send(t *testing.T, amount int64) View {
	t.Helper()
	v, err := s.svc.Create(s.tolu.ctx, Request{SourceAccountID: s.tolu.account, Destination: toBank("058", "0123456789"), Amount: ngn(amount)})
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func (s *sagaFixture) reload(t *testing.T, id uuid.UUID) View {
	t.Helper()
	v, err := s.svc.view(t.Context(), s.tolu.id, id)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func (s *sagaFixture) available(t *testing.T) int64 {
	t.Helper()
	b, err := ledger.GetBalances(t.Context(), s.pool, s.tolu.account)
	if err != nil {
		t.Fatal(err)
	}
	return b.Available.Amount()
}

func (s *sagaFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	if err := s.pool.QueryRow(t.Context(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestExternalTransferHoldsThenSettlesOnTheStatusCheck(t *testing.T) {
	t.Parallel()
	s := newSaga(t)
	v := s.send(t, 1_000_000)

	if v.Status != "processing" || v.Rail != "interbank" || v.HoldID == nil || *v.Partner != "fake" || *v.AccountNumber != "0123456789" {
		t.Fatalf("created = %+v", v.Transfer)
	}
	// Held, not debited: available drops, the ledger balance does not.
	if s.available(t) != 4_000_000 || s.balance(s.tolu) != 5_000_000 {
		t.Fatalf("available %d, ledger %d", s.available(t), s.balance(s.tolu))
	}
	// The send and the deadline check were queued with the transfer.
	if n := s.count(t, `SELECT count(*) FROM river_job WHERE kind IN ('transfer_send', 'transfer_check') AND args->>'transfer_id' = $1`, v.ID.String()); n != 2 {
		t.Fatalf("queued saga jobs = %d", n)
	}

	for range 2 { // River may run a job twice; the partner still sees one payment
		if err := s.svc.SendExternal(t.Context(), v.ID); err != nil {
			t.Fatal(err)
		}
	}
	if s.partner.sends[v.Reference] != 1 {
		t.Fatalf("partner received %d sends", s.partner.sends[v.Reference])
	}
	if n := s.count(t, `SELECT count(*) FROM river_job WHERE kind = 'transfer_check' AND (args->>'attempt')::int = 1 AND args->>'transfer_id' = $1`, v.ID.String()); n != 1 {
		t.Fatalf("first poll queued %d times", n)
	}

	// Still pending: the check queues the next one and changes nothing.
	if err := s.svc.CheckExternal(t.Context(), v.ID, 1); err != nil {
		t.Fatal(err)
	}
	if got := s.reload(t, v.ID); got.Status != "processing" {
		t.Fatalf("pending check moved it to %s", got.Status)
	}

	s.partner.answer(v.Reference, partners.Result{State: partners.Settled, PartnerReference: "S-" + v.Reference})
	if err := s.svc.CheckExternal(t.Context(), v.ID, 2); err != nil {
		t.Fatal(err)
	}
	got := s.reload(t, v.ID)
	if got.Status != "completed" || got.EntryID == nil || fmt.Sprint(statuses(got)) != "[created risk_checked processing completed]" ||
		got.Timeline[3].Label != "Received by Guaranty Trust Bank" {
		t.Fatalf("settled = %+v %v", got.Transfer, statuses(got))
	}
	if s.available(t) != 4_000_000 || s.balance(s.tolu) != 4_000_000 {
		t.Fatalf("after settling: available %d, ledger %d", s.available(t), s.balance(s.tolu))
	}
	clearing, err := ledger.SystemAccount(t.Context(), s.pool, ledger.KindPartnerSettlement, "NGN")
	if err != nil || clearing.BalanceMinor != 1_000_000 {
		t.Fatalf("partner settlement = %d, %v", clearing.BalanceMinor, err)
	}
	line, err := s.accts.Transaction(s.tolu.ctx, got.TransactionID)
	if err != nil || line.Status != "completed" || *line.BalanceAfterMinor != 4_000_000 {
		t.Fatalf("line = %+v, %v", line, err)
	}
	// A late duplicate answer does nothing.
	if out, err := s.svc.Conclude(t.Context(), v.ID, partners.Result{State: partners.Settled}); err != nil || out != outcomeAlreadyFinal {
		t.Fatalf("second settle = %s, %v", out, err)
	}
	if n := s.count(t, `SELECT count(*) FROM outbox_events WHERE topic = 'transfer.completed' AND aggregate_id = $1`, v.ID.String()); n != 1 {
		t.Fatalf("completed events = %d", n)
	}
}

func TestAFailedExternalTransferIsAutoReversed(t *testing.T) {
	t.Parallel()
	s := newSaga(t)
	v := s.send(t, 1_000_000)
	if err := s.svc.SendExternal(t.Context(), v.ID); err != nil {
		t.Fatal(err)
	}
	s.partner.answer(v.Reference, partners.Result{State: partners.Failed, FailureCode: "91"})
	if err := s.svc.CheckExternal(t.Context(), v.ID, 1); err != nil {
		t.Fatal(err)
	}
	got := s.reload(t, v.ID)
	if got.Status != "reversed" || fmt.Sprint(statuses(got)) != "[created risk_checked processing failed reversed]" {
		t.Fatalf("reversed = %+v %v", got.Transfer, statuses(got))
	}
	var rev api.Reversal
	if err := json.Unmarshal(got.Reversal, &rev); err != nil || !strings.Contains(rev.Reason, "not available") || rev.TransactionId != got.TransactionID {
		t.Fatalf("reversal = %+v, %v", rev, err)
	}
	// Nothing ever left: the hold is gone and every kobo is spendable again.
	if s.available(t) != 5_000_000 || s.balance(s.tolu) != 5_000_000 {
		t.Fatalf("after reversal: available %d, ledger %d", s.available(t), s.balance(s.tolu))
	}
	if line, err := s.accts.Transaction(s.tolu.ctx, got.TransactionID); err != nil || line.Status != "failed" {
		t.Fatalf("line = %+v, %v", line, err)
	}
	if n := s.count(t, `SELECT count(*) FROM outbox_events WHERE topic = 'transfer.failed' AND aggregate_id = $1`, v.ID.String()); n != 1 {
		t.Fatalf("failed events = %d", n)
	}
}

func TestARefusedSendIsReversedAtOnce(t *testing.T) {
	t.Parallel()
	s := newSaga(t)
	v := s.send(t, 200_000)
	s.partner.sendErr = fmt.Errorf("%w: account blocked", partners.ErrRejected)
	if err := s.svc.SendExternal(t.Context(), v.ID); err != nil {
		t.Fatal(err)
	}
	if got := s.reload(t, v.ID); got.Status != "reversed" || s.available(t) != 5_000_000 {
		t.Fatalf("refused send = %s, available %d", got.Status, s.available(t))
	}
}

func TestAPartnerThatNeverAnswersIsReversedAtTheDeadline(t *testing.T) {
	t.Parallel()
	s := newSaga(t)
	v := s.send(t, 300_000)
	if err := s.svc.SendExternal(t.Context(), v.ID); err != nil {
		t.Fatal(err)
	}
	// At the deadline the partner still says pending: the customer gets the money back.
	s.advance(DefaultSagaTimeout)
	if err := s.svc.CheckExternal(t.Context(), v.ID, 0); err != nil {
		t.Fatal(err)
	}
	got := s.reload(t, v.ID)
	if got.Status != "reversed" || !strings.Contains(*got.Timeline[3].Detail, "did not answer in time") || s.available(t) != 5_000_000 {
		t.Fatalf("deadline = %+v, available %d", got.Transfer, s.available(t))
	}
	// After the deadline nothing is sent.
	if err := s.svc.SendExternal(t.Context(), v.ID); err != nil || s.partner.sends[v.Reference] != 1 {
		t.Fatalf("resend after reversal: %v, sends %d", err, s.partner.sends[v.Reference])
	}

	// The partner pays after all: flagged for reconciliation, no money moved by us.
	out, err := s.svc.HandlePartnerCallback(t.Context(), "fake", "evt-late", api.PartnerCallback{
		EventType: api.PartnerCallbackEventTypeTransferSettled, Reference: v.Reference, OccurredAt: s.now(),
	})
	if err != nil || out != outcomeLateSettlement {
		t.Fatalf("late settlement = %s, %v", out, err)
	}
	if n := s.count(t, `SELECT count(*) FROM outbox_events WHERE topic = 'transfer.late_settlement' AND aggregate_id = $1`, v.ID.String()); n != 1 ||
		s.balance(s.tolu) != 5_000_000 {
		t.Fatalf("late settlement events %d, balance %d", n, s.balance(s.tolu))
	}
}

func TestPartnerCallbacksSettleOnceAndAreDeduplicated(t *testing.T) {
	t.Parallel()
	s := newSaga(t)
	v := s.send(t, 1_000_000)
	if err := s.svc.SendExternal(t.Context(), v.ID); err != nil {
		t.Fatal(err)
	}
	ctx := t.Context()
	amount := api.Money{AmountMinor: "1000000", Currency: api.CurrencyCode(money.NGN)}
	settled := api.PartnerCallback{EventType: api.PartnerCallbackEventTypeTransferSettled, Reference: v.Reference, OccurredAt: s.now(), Amount: &amount}

	wrong := api.Money{AmountMinor: "999", Currency: "NGN"}
	for name, tc := range map[string]struct {
		partner string
		cb      api.PartnerCallback
	}{
		"another partner":   {"sandbox_nip", settled},
		"a different sum":   {"fake", api.PartnerCallback{EventType: settled.EventType, Reference: v.Reference, OccurredAt: s.now(), Amount: &wrong}},
		"unknown reference": {"fake", api.PartnerCallback{EventType: settled.EventType, Reference: "NEM20261109ZZZZZZ", OccurredAt: s.now()}},
		"not for transfers": {"fake", api.PartnerCallback{EventType: api.PartnerCallbackEventTypeBillCompleted, Reference: v.Reference, OccurredAt: s.now()}},
	} {
		if out, err := s.svc.HandlePartnerCallback(ctx, tc.partner, "evt-"+name, tc.cb); err != nil || out != outcomeIgnored {
			t.Errorf("%s: %s, %v", name, out, err)
		}
	}
	if got := s.reload(t, v.ID); got.Status != "processing" {
		t.Fatalf("an ignored callback moved it to %s", got.Status)
	}

	for i, want := range []string{outcomeSettled, outcomeAlreadyFinal, outcomeAlreadyFinal} {
		if out, err := s.svc.HandlePartnerCallback(ctx, "fake", "evt-1", settled); err != nil || out != want {
			t.Fatalf("delivery %d = %s, %v; want %s", i+1, out, err, want)
		}
	}
	if got := s.reload(t, v.ID); got.Status != "completed" || s.balance(s.tolu) != 4_000_000 {
		t.Fatalf("after callbacks: %s, balance %d", got.Status, s.balance(s.tolu))
	}
	if n := s.count(t, `SELECT count(*) FROM partner_webhook_events WHERE partner = 'fake' AND event_id = 'evt-1'`); n != 1 {
		t.Fatalf("recorded %d times", n)
	}
	if n := s.count(t, `SELECT count(*) FROM journal_entries WHERE kind = 'transfer_external' AND reference = $1`, v.Reference); n != 1 {
		t.Fatalf("settled by %d entries", n)
	}
}

func TestPartnerCallbackSignatures(t *testing.T) {
	t.Parallel()
	s := newSaga(t)
	body := []byte(`{"event_type":"transfer.settled"}`)
	ok := partners.Sign([]byte("fake-secret"), s.now(), body)
	if err := s.svc.VerifyPartnerCallback(t.Context(), "fake", ok, body); err != nil {
		t.Fatalf("good signature: %v", err)
	}
	for name, tc := range map[string]struct{ partner, sig string }{
		"wrong secret":       {"fake", partners.Sign([]byte("guess"), s.now(), body)},
		"partner not set up": {"paystack_test", ok},
		"no signature":       {"fake", ""},
	} {
		if err := s.svc.VerifyPartnerCallback(t.Context(), tc.partner, tc.sig, body); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
