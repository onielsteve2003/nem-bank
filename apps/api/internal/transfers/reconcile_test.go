package transfers

import (
	"context"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
)

// reportingPartner is a fakePartner that also publishes a settlement file.
type reportingPartner struct {
	*fakePartner
	file []partners.Settlement
}

func (p *reportingPartner) SettlementReport(context.Context, time.Time, time.Time) ([]partners.Settlement, error) {
	return p.file, nil
}

func TestReconcileFindsEveryKindOfMismatch(t *testing.T) {
	t.Parallel()
	rp := &reportingPartner{fakePartner: newFakePartner()}
	s := &sagaFixture{partner: rp.fakePartner, clock: time.Now()}
	s.fixture = newFixtureWith(t, func(c *Config) {
		c.Partner, c.Now = rp, s.now
	})
	s.tolu = s.customer("Tolu", "tolu", 5_000_000)

	settle := func(amount int64) View {
		v := s.send(t, amount)
		if err := s.svc.SendExternal(t.Context(), v.ID); err != nil {
			t.Fatal(err)
		}
		s.partner.answer(v.Reference, partners.Result{State: partners.Settled})
		if err := s.svc.CheckExternal(t.Context(), v.ID, 1); err != nil {
			t.Fatal(err)
		}
		return s.reload(t, v.ID)
	}
	good, wrong, lost := settle(100_000), settle(200_000), settle(300_000)
	// The partner's file: the first right, the second for a different amount, the third
	// absent (and the partner now says it never settled), plus a payment Nem never made.
	s.partner.answer(lost.Reference, partners.Result{State: partners.Failed})
	rp.file = []partners.Settlement{
		{Reference: good.Reference, Amount: money.New(100_000, money.NGN)},
		{Reference: wrong.Reference, Amount: money.New(250_000, money.NGN)},
		{Reference: "NEM20260101ZZZZZZ", Amount: money.New(900_000, money.NGN)},
	}

	r, err := s.svc.Reconcile(t.Context(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if r.Matched != 1 || len(r.Items) != 3 || r.Partner != "fake" {
		t.Fatalf("report = matched %d, items %+v", r.Matched, r.Items)
	}
	byRef := map[string]ReconItem{}
	for _, it := range r.Items {
		byRef[it.Reference] = it
	}
	if it := byRef[wrong.Reference]; it.Status != ReconAmountMismatch || it.Ledger.Amount() != 200_000 || it.Partner.Amount() != 250_000 {
		t.Fatalf("wrong amount = %+v", it)
	}
	if it := byRef[lost.Reference]; it.Status != ReconMissingAtPartner || it.Partner != nil || it.Ledger.Amount() != 300_000 {
		t.Fatalf("lost = %+v", it)
	}
	if it := byRef["NEM20260101ZZZZZZ"]; it.Status != ReconMissingInLedger || it.Ledger != nil || it.Partner.Amount() != 900_000 {
		t.Fatalf("stranger = %+v", it)
	}

	// A completed transfer the file lacks but the partner confirms (settled in another
	// window) is matched, not reported.
	s.partner.answer(lost.Reference, partners.Result{State: partners.Settled})
	r, err = s.svc.Reconcile(t.Context(), time.Now())
	if err != nil || r.Matched != 2 || len(r.Items) != 2 {
		t.Fatalf("after the partner confirmed: %+v, %v", r, err)
	}

	// Tomorrow has not happened.
	if _, err := s.svc.Reconcile(t.Context(), time.Now().AddDate(0, 0, 2)); err == nil {
		t.Fatal("future day reconciled")
	}
}

func TestReconcileNeedsAPartnerWithAFile(t *testing.T) {
	t.Parallel()
	s := newSaga(t) // the plain fake publishes no settlement file
	if _, err := s.svc.Reconcile(t.Context(), time.Now()); err == nil {
		t.Fatal("reconciled without a settlement file")
	}
	if err := s.svc.ReconcileYesterday(t.Context()); err != nil {
		t.Fatalf("the daily job should skip a partner with no file: %v", err)
	}
}
