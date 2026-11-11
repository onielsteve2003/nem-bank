package cards

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func TestNewPANIsLuhnValidSixteenDigitsOnTheTestBIN(t *testing.T) {
	t.Parallel()
	for _, bin := range []string{binVerve, binVisa} {
		for range 200 {
			pan, err := newPAN(bin)
			if err != nil {
				t.Fatal(err)
			}
			if len(pan) != 16 || !strings.HasPrefix(pan, bin) || !luhnValid(pan) {
				t.Fatalf("pan %q is not a Luhn-valid 16-digit number on BIN %s", pan, bin)
			}
		}
	}
}

func TestLuhnKnownNumbers(t *testing.T) {
	t.Parallel()
	for pan, want := range map[string]bool{
		"4539578763621486": true, // textbook Luhn-valid test number
		"4539578763621487": false,
		"79927398713":      true, // the Wikipedia example
		"79927398710":      false,
		"45395787636214x6": false,
		"":                 false,
	} {
		if got := luhnValid(pan); got != want {
			t.Errorf("luhnValid(%q) = %v, want %v", pan, got, want)
		}
	}
}

func TestIssueCreatesAnEncryptedCardOnTheRightNetwork(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)

	naira, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard, Nickname: "  Shopping  "})
	if err != nil {
		t.Fatal(err)
	}
	if naira.Currency != "NGN" || naira.Network != "nem_verve" || naira.Status != StatusActive || naira.InternationalEnabled {
		t.Fatalf("naira card = %+v", naira)
	}
	if naira.Nickname == nil || *naira.Nickname != "Shopping" || naira.Design != "volt" || naira.NameOnCard != "TOLU ADEYEMI" {
		t.Fatalf("naira card details = %+v", naira)
	}
	dollar, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.usd, Type: TypeSingleUse, Design: "noir"})
	if err != nil {
		t.Fatal(err)
	}
	if dollar.Network != "nem_visa" || !dollar.InternationalEnabled || dollar.Type != TypeSingleUse {
		t.Fatalf("dollar card = %+v", dollar)
	}
	// Four years ahead, as the mock bank does.
	if dollar.ExpiryYear != 2030 || dollar.ExpiryMonth != 11 {
		t.Fatalf("expiry = %d/%d", dollar.ExpiryMonth, dollar.ExpiryYear)
	}

	// The number is not in the table in the clear, and the stored ciphertext opens only with
	// this card's own ID as the bound context.
	pan, err := f.ring.Decrypt(naira.PanEnc, panAAD(naira.ID))
	if err != nil {
		t.Fatal(err)
	}
	if !luhnValid(string(pan)) || string(pan)[12:] != naira.Last4 {
		t.Fatalf("decrypted number %q does not match last4 %q", pan, naira.Last4)
	}
	if bytes.Contains(naira.PanEnc, pan) {
		t.Fatal("the stored card number contains the number in the clear")
	}
	if _, err := f.ring.Decrypt(naira.PanEnc, panAAD(dollar.ID)); err == nil {
		t.Fatal("a card number moved to another card's row must not decrypt")
	}
	var leaked bool
	if err := f.pool.QueryRow(t.Context(), `SELECT bool_or(position($1 in encode(pan_enc, 'escape')) > 0) FROM cards`, string(pan)).Scan(&leaked); err != nil {
		t.Fatal(err)
	}
	if leaked {
		t.Fatal("the card number appears in the cards table")
	}

	// The API shape never carries the number or the CVV.
	raw, err := json.Marshal(CardJSON(naira))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), string(pan)) || strings.Contains(string(raw), `"cvv"`) || strings.Contains(string(raw), `"pan"`) {
		t.Fatalf("card JSON leaks secrets: %s", raw)
	}
}

func TestIssueRules(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	other := f.customer(0, 0)

	t.Run("tier 1 cannot hold a card", func(t *testing.T) {
		low := f.customer(0, 0)
		f.profs.setTier(low.id, 1)
		_, err := f.svc.Issue(low.ctx, IssueRequest{AccountID: low.ngn, Type: TypeStandard})
		wantProblem(t, err, "kyc_tier_required")
	})
	t.Run("someone else's account is not found", func(t *testing.T) {
		_, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: other.ngn, Type: TypeStandard})
		if err == nil {
			t.Fatal("issued a card on another customer's account")
		}
		var p *problem.Error
		if !errors.As(err, &p) || p.Status != 404 {
			t.Fatalf("err = %v, want 404", err)
		}
	})
	t.Run("pounds are not a card currency", func(t *testing.T) {
		_, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.gbp, Type: TypeStandard})
		wantProblem(t, err, problem.CodeValidationFailed)
	})
	t.Run("a merchant-locked card needs its merchant", func(t *testing.T) {
		_, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeMerchantLocked})
		wantProblem(t, err, problem.CodeValidationFailed)
		card, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeMerchantLocked, MerchantLock: &MerchantLock{ID: "m_bolt", Name: "Bolt"}})
		if err != nil {
			t.Fatal(err)
		}
		if card.MerchantID == nil || *card.MerchantID != "m_bolt" || *card.MerchantName != "Bolt" {
			t.Fatalf("lock = %v %v", card.MerchantID, card.MerchantName)
		}
	})
	t.Run("the spend limit must be positive and in the card's currency", func(t *testing.T) {
		_, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard,
			SpendLimit: &SpendLimit{Amount: money.New(100, money.USD), Period: Daily}})
		wantProblem(t, err, problem.CodeValidationFailed)
		_, err = f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard,
			SpendLimit: &SpendLimit{Amount: money.New(0, money.NGN), Period: Daily}})
		wantProblem(t, err, problem.CodeValidationFailed)
		card, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard,
			SpendLimit: &SpendLimit{Amount: money.New(5_000_00, money.NGN), Period: Monthly}})
		if err != nil {
			t.Fatal(err)
		}
		if card.SpendLimitMinor == nil || *card.SpendLimitMinor != 5_000_00 || *card.SpendLimitPeriod != Monthly {
			t.Fatalf("limit = %v %v", card.SpendLimitMinor, card.SpendLimitPeriod)
		}
	})
	t.Run("a nickname over thirty characters is refused", func(t *testing.T) {
		_, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard, Nickname: strings.Repeat("x", 31)})
		wantProblem(t, err, problem.CodeValidationFailed)
	})
}

func TestAtMostFiveLiveCardsEvenWhenRacing(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	for range 3 {
		if _, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard}); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	errs := make([]error, 6)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
		}()
	}
	wg.Wait()
	var made int
	for _, err := range errs {
		if err == nil {
			made++
			continue
		}
		wantProblem(t, err, "limit_reached")
	}
	if made != 2 {
		t.Fatalf("%d racing issues succeeded with 3 live cards, want exactly 2", made)
	}
	list, err := f.svc.List(c.ctx)
	if err != nil || len(list) != 5 {
		t.Fatalf("list = %d cards, err %v; want 5", len(list), err)
	}
}

func TestRevealNeedsStepUpAndLeavesATrace(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	card, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	if err != nil {
		t.Fatal(err)
	}

	_, err = f.svc.Reveal(c.ctx, card.ID, "")
	wantProblem(t, err, "step_up_required")
	_, err = f.svc.Reveal(c.ctx, card.ID, "forged")
	wantProblem(t, err, "step_up_required")

	s, err := f.svc.Reveal(c.ctx, card.ID, "good")
	if err != nil {
		t.Fatal(err)
	}
	if !luhnValid(s.PAN) || s.PAN[12:] != card.Last4 || len(s.CVV) != 3 {
		t.Fatalf("secrets = %+v", s)
	}
	if s.Month != int(card.ExpiryMonth) || s.Year != int(card.ExpiryYear) {
		t.Fatalf("expiry %d/%d != card %d/%d", s.Month, s.Year, card.ExpiryMonth, card.ExpiryYear)
	}
	if want := f.clk.Now().Add(RevealWindow); !s.VisibleUntil.Equal(want) {
		t.Fatalf("visible until %v, want %v", s.VisibleUntil, want)
	}
	// The CVV is derived, so a second reveal shows the same one.
	f.steps.reset()
	again, err := f.svc.Reveal(c.ctx, card.ID, "good")
	if err != nil || again.CVV != s.CVV || again.PAN != s.PAN {
		t.Fatalf("second reveal = %+v, %v; want the same details", again, err)
	}
	// One audit entry per successful reveal, none for the refused ones, no number in it.
	var n int
	var meta string
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*), coalesce(string_agg(metadata::text, ''), '') FROM audit_log WHERE action = 'card.reveal'`).Scan(&n, &meta); err != nil {
		t.Fatal(err)
	}
	if n != 2 || strings.Contains(meta, s.PAN) {
		t.Fatalf("audit entries = %d (metadata %q), want 2 without the number", n, meta)
	}
}

func TestRevealIsOnlyForTheOwnerAndLiveCards(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	other := f.customer(0, 0)
	card, err := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.svc.Reveal(other.ctx, card.ID, "good"); err == nil {
		t.Fatal("another customer revealed the card")
	}
	if _, err := f.svc.Get(other.ctx, card.ID); err == nil {
		t.Fatal("another customer read the card")
	}
	if _, err := f.svc.Reveal(c.ctx, uuid.New(), "good"); err == nil {
		t.Fatal("revealed a card that does not exist")
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE cards SET status = 'terminated', terminated_at = now() WHERE id = $1`, card.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.svc.Reveal(c.ctx, card.ID, "good")
	wantProblem(t, err, "invalid_state")
}

func TestListPutsTerminatedCardsLast(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(0, 0)
	first, _ := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	second, _ := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	third, _ := f.svc.Issue(c.ctx, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	if _, err := f.pool.Exec(t.Context(), `UPDATE cards SET status = 'terminated', terminated_at = now() WHERE id = $1`, third.ID); err != nil {
		t.Fatal(err)
	}
	list, err := f.svc.List(c.ctx)
	if err != nil || len(list) != 3 {
		t.Fatalf("list = %d, %v", len(list), err)
	}
	if list[0].ID != second.ID || list[1].ID != first.ID || list[2].ID != third.ID {
		t.Fatalf("order = %v %v %v, want newest live first, terminated last", list[0].ID, list[1].ID, list[2].ID)
	}
}
