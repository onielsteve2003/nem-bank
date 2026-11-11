package cards

import (
	"sync"
	"testing"
	"time"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

func TestBillingPricesOnTheBanksSideOfTheSpread(t *testing.T) {
	t.Parallel()
	views, _ := rates{}.Rates(t.Context())
	for name, tc := range map[string]struct {
		amount money.Money
		card   money.Currency
		want   int64
	}{
		"same currency passes through":          {money.New(123_45, money.NGN), money.NGN, 123_45},
		"dollars on a naira card: sell rate":    {money.New(10_00, money.USD), money.NGN, 16_240_00},
		"naira on a dollar card: buy rate, up":  {money.New(16_240_00, money.NGN), money.USD, 10_31},
		"pounds on a dollar card go via naira":  {money.New(10_00, money.GBP), money.USD, 12_89},
		"a single kobo still costs a cent":      {money.New(1, money.NGN), money.USD, 1},
		"dollar charge on a dollar card stays":  {money.New(5_00, money.USD), money.USD, 5_00},
		"pounds on a naira card: sell rate x10": {money.New(10_00, money.GBP), money.NGN, 20_300_00},
	} {
		got, err := billing(tc.amount, tc.card, views)
		if err != nil || got.Amount() != tc.want || got.Currency() != tc.card {
			t.Errorf("%s: billing = %v, %v; want %d %s", name, got, err, tc.want, tc.card)
		}
	}
	if _, err := billing(money.New(10_00, money.EUR), money.NGN, views); err == nil {
		t.Error("a currency with no rate must not be priced")
	}
	if _, err := billing(money.New(10_00, money.NGN), money.USD, nil); err == nil {
		t.Error("no rates must not be priced")
	}
}

func TestDecideOrderAndLimits(t *testing.T) {
	t.Parallel()
	base := func() ChargeRequest {
		return ChargeRequest{Channel: ChannelOnline, Amount: naira(1_000), Merchant: Merchant{ID: "m1", Country: "NG"}}
	}
	ok := facts{billing: naira(1_000), accountActive: true}
	card := func() cardsdbCard { return cardsdbCard{Status: StatusActive, OnlineEnabled: true} }

	// A frozen card that is also over its limit is declined as frozen: switches before limits.
	c := card()
	c.Status = StatusFrozen
	c.SpendLimitMinor, c.SpendLimitPeriod = ptr(int64(1)), ptr(PerTransaction)
	if got := decide(c.row(), base(), ok); got != DeclineCardFrozen {
		t.Fatalf("decide = %q, want card_frozen", got)
	}
	// Per-transaction limits ignore what was spent before.
	c = card()
	c.SpendLimitMinor, c.SpendLimitPeriod = ptr(int64(1_000_00)), ptr(PerTransaction)
	if got := decide(c.row(), base(), facts{billing: naira(1_000), accountActive: true, spent: 999_999_00}); got != "" {
		t.Fatalf("per-transaction limit counted history: %q", got)
	}
	// Exactly the limit is allowed; one kobo over is not.
	c.SpendLimitPeriod = ptr(Daily)
	if got := decide(c.row(), base(), facts{billing: naira(400), accountActive: true, spent: 600_00}); got != "" {
		t.Fatalf("a charge landing exactly on the limit was declined: %q", got)
	}
	if got := decide(c.row(), base(), facts{billing: money.New(400_01, money.NGN), accountActive: true, spent: 600_00}); got != DeclineLimitExceeded {
		t.Fatalf("one kobo over = %q, want limit_exceeded", got)
	}
	// A frozen account declines like a frozen card.
	if got := decide(card().row(), base(), facts{billing: naira(1), accountActive: false}); got != DeclineCardFrozen {
		t.Fatalf("frozen account = %q", got)
	}
}

func TestAuthorizeApprovesAndHoldsTheMoney(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})

	a, err := f.svc.Authorize(t.Context(), card.charge(naira(3_500), ChannelOnline))
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != AuthAuthorized || a.HoldID == nil || a.DeclineReason != nil || a.BillingMinor != 3_500_00 {
		t.Fatalf("authorization = %+v", a)
	}
	ledgerBal, avail := f.available(c.ngn)
	if ledgerBal != 10_000_00 || avail != 6_500_00 {
		t.Fatalf("ledger %d available %d; want the money held, not moved", ledgerBal, avail)
	}
	var reason, ref string
	var amount int64
	var expires time.Time
	if err := f.pool.QueryRow(t.Context(), `SELECT reason, reference, amount_minor, expires_at FROM account_holds WHERE id = $1 AND status = 'active'`, *a.HoldID).
		Scan(&reason, &ref, &amount, &expires); err != nil {
		t.Fatal(err)
	}
	if reason != "card_authorization" || ref != a.ID.String() || amount != 3_500_00 || !expires.Equal(f.clk.Now().Add(HoldLifetime)) {
		t.Fatalf("hold = %s %s %d %v", reason, ref, amount, expires)
	}
	if a.ExpiresAt == nil || !a.ExpiresAt.Equal(expires) {
		t.Fatalf("authorization expiry %v != hold expiry %v", a.ExpiresAt, expires)
	}
}

func TestAuthorizeRefusesDetailsThatDoNotMatchAnActiveCard(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	gone := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	if _, err := f.svc.Terminate(c.ctx, gone.card.ID); err != nil {
		t.Fatal(err)
	}
	unknown, err := newPAN(binVerve)
	if err != nil {
		t.Fatal(err)
	}

	bad := map[string]ChargeRequest{}
	r := card.charge(naira(100), ChannelOnline)
	r.CVV = wrongCVV(card.cvv)
	bad["wrong CVV"] = r
	r = card.charge(naira(100), ChannelOnline)
	r.Month = r.Month%12 + 1
	bad["wrong expiry month"] = r
	r = card.charge(naira(100), ChannelOnline)
	r.Year++
	bad["wrong expiry year"] = r
	r = card.charge(naira(100), ChannelOnline)
	r.PAN = unknown
	bad["unknown number"] = r
	r = card.charge(naira(100), ChannelOnline)
	r.PAN = r.PAN[:15] + string(rune('0'+(int(r.PAN[15]-'0')+1)%10))
	bad["number failing Luhn"] = r
	bad["terminated card"] = gone.charge(naira(100), ChannelOnline)
	bad["zero amount"] = card.charge(money.New(0, money.NGN), ChannelOnline)

	for name, req := range bad {
		_, err := f.svc.Authorize(t.Context(), req)
		if err == nil {
			t.Errorf("%s: authorized", name)
			continue
		}
		wantProblem(t, err, "invalid_card")
	}
	var n, holds int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM card_authorizations), (SELECT count(*) FROM account_holds)`).Scan(&n, &holds); err != nil {
		t.Fatal(err)
	}
	if n != 0 || holds != 0 {
		t.Fatalf("%d authorizations and %d holds recorded for requests that matched no card", n, holds)
	}
}

func wrongCVV(cvv string) string {
	if cvv == "000" {
		return "001"
	}
	return "000"
}

func TestAuthorizeDeclinesAndRecordsWhy(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)

	type tc struct {
		name   string
		setup  func(i issued)
		req    func(i issued) ChargeRequest
		reason string
	}
	online := func(i issued) ChargeRequest { return i.charge(naira(1_000), ChannelOnline) }
	cases := []tc{
		{"frozen card", func(i issued) { mustOK(f.svc.Freeze(c.ctx, i.card.ID)) }, online, DeclineCardFrozen},
		{"online switched off", func(i issued) { mustOK(f.svc.UpdateControls(c.ctx, i.card.ID, Update{Online: ptr(false)})) }, online, DeclineOnlineDisabled},
		{"abroad on a home-only card", nil, func(i issued) ChargeRequest {
			r := online(i)
			r.Merchant.Country = "US"
			return r
		}, DeclineInternationalDisabled},
		{"another merchant than the lock", func(i issued) {
			mustOK(f.svc.UpdateControls(c.ctx, i.card.ID, Update{MerchantLock: &MerchantLock{ID: "m_bolt", Name: "Bolt"}}))
		}, online, DeclineMerchantNotAllowed},
		{"over the per-transaction limit", func(i issued) {
			mustOK(f.svc.UpdateControls(c.ctx, i.card.ID, Update{SpendLimit: &SpendLimit{Amount: naira(999), Period: PerTransaction}}))
		}, online, DeclineLimitExceeded},
		{"more than the account has", nil, func(i issued) ChargeRequest { return i.charge(naira(10_001), ChannelOnline) }, DeclineInsufficientFunds},
		{"a used single-use card", func(i issued) {
			if _, err := f.pool.Exec(t.Context(), `UPDATE cards SET status = 'used' WHERE id = $1`, i.card.ID); err != nil {
				t.Fatal(err)
			}
		}, online, DeclineCardUsed},
	}
	for _, tc := range cases {
		card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
		if tc.setup != nil {
			tc.setup(card)
		}
		a, err := f.svc.Authorize(t.Context(), tc.req(card))
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if a.Status != AuthDeclined || a.DeclineReason == nil || *a.DeclineReason != tc.reason || a.HoldID != nil {
			t.Errorf("%s: authorization = %+v, want declined for %s with no hold", tc.name, a, tc.reason)
		}
		// Leave room for the next case: nothing may be held by a decline.
		if _, avail := f.available(c.ngn); avail != 10_000_00 {
			t.Errorf("%s: available = %d after a decline", tc.name, avail)
		}
		// Terminate so the five-card cap does not end the loop early.
		mustOK(f.svc.Terminate(c.ctx, card.card.ID))
	}
}

func TestInStoreChargesIgnoreTheOnlineSwitch(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(10_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	mustOK(f.svc.UpdateControls(c.ctx, card.card.ID, Update{Online: ptr(false)}))
	a, err := f.svc.Authorize(t.Context(), card.charge(naira(500), ChannelInStore))
	if err != nil || a.Status != AuthAuthorized {
		t.Fatalf("in-store charge = %+v, %v; want approved", a, err)
	}
}

func TestSpendLimitsCountApprovedChargesPerLagosPeriod(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(50_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard,
		SpendLimit: &SpendLimit{Amount: naira(5_000), Period: Daily}})
	try := func(n int64) string {
		a, err := f.svc.Authorize(t.Context(), card.charge(naira(n), ChannelOnline))
		if err != nil {
			t.Fatal(err)
		}
		if a.DeclineReason != nil {
			return *a.DeclineReason
		}
		return ""
	}
	if got := try(3_000); got != "" {
		t.Fatalf("first charge: %q", got)
	}
	if got := try(2_500); got != DeclineLimitExceeded {
		t.Fatalf("charge over the day's limit: %q", got)
	}
	// The declined attempt did not use any of the limit.
	if got := try(2_000); got != "" {
		t.Fatalf("charge that fits after a decline: %q", got)
	}
	if got := try(1); got != DeclineLimitExceeded {
		t.Fatalf("the day's limit is spent: %q", got)
	}
	// 10:00 UTC is 11:00 in Lagos; fourteen hours on is 01:00 the next Lagos day.
	f.clk.advance(14 * time.Hour)
	if got := try(5_000); got != "" {
		t.Fatalf("a new Lagos day starts a new limit: %q", got)
	}

	monthly := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard,
		SpendLimit: &SpendLimit{Amount: naira(8_000), Period: Monthly}})
	pay := func(n int64) string {
		a, err := f.svc.Authorize(t.Context(), monthly.charge(naira(n), ChannelOnline))
		if err != nil {
			t.Fatal(err)
		}
		if a.DeclineReason != nil {
			return *a.DeclineReason
		}
		return ""
	}
	if pay(5_000) != "" || pay(3_001) != DeclineLimitExceeded || pay(3_000) != "" {
		t.Fatal("monthly limit not counted across charges")
	}
	f.clk.advance(24 * time.Hour) // still the same month
	if pay(1) != DeclineLimitExceeded {
		t.Fatal("monthly limit reset inside the month")
	}
	f.clk.advance(30 * 24 * time.Hour)
	if pay(8_000) != "" {
		t.Fatal("monthly limit did not reset in a new month")
	}
}

func TestSingleUseCardTakesOneChargeEvenWhenRacing(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(50_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeSingleUse})
	var wg sync.WaitGroup
	results := make([]string, 6)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := f.svc.Authorize(t.Context(), card.charge(naira(100), ChannelOnline))
			if err != nil {
				results[i] = "error: " + err.Error()
			} else {
				results[i] = a.Status
			}
		}()
	}
	wg.Wait()
	approved := 0
	for _, r := range results {
		switch r {
		case AuthAuthorized:
			approved++
		case AuthDeclined:
		default:
			t.Fatalf("unexpected result %q", r)
		}
	}
	if approved != 1 {
		t.Fatalf("%d racing charges approved on a single-use card, want 1: %v", approved, results)
	}
}

func TestRacingChargesCannotHoldMoreThanTheAccountHas(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(1_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	var wg sync.WaitGroup
	statuses := make([]string, 8)
	for i := range statuses {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := f.svc.Authorize(t.Context(), card.charge(naira(400), ChannelOnline))
			if err != nil {
				statuses[i] = "error: " + err.Error()
				return
			}
			statuses[i] = a.Status
			if a.DeclineReason != nil && *a.DeclineReason != DeclineInsufficientFunds {
				statuses[i] = "wrong reason " + *a.DeclineReason
			}
		}()
	}
	wg.Wait()
	approved := 0
	for _, s := range statuses {
		switch s {
		case AuthAuthorized:
			approved++
		case AuthDeclined:
		default:
			t.Fatalf("unexpected result %q", s)
		}
	}
	if _, avail := f.available(c.ngn); approved != 2 || avail != 200_00 {
		t.Fatalf("%d approved, available %d; want 2 approved leaving ₦200", approved, avail)
	}
}

func TestForeignChargesAreConvertedToTheCardsCurrency(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	c := f.customer(100_000_00, 100_00)
	naira := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	abroad := func(i issued, amount money.Money) ChargeRequest {
		r := i.charge(amount, ChannelOnline)
		r.Merchant = Merchant{ID: "m_aws", Name: "Cloud Co", MCC: "7372", Country: "US"}
		return r
	}
	a, err := f.svc.Authorize(t.Context(), abroad(naira, money.New(10_00, money.USD)))
	if err != nil {
		t.Fatal(err)
	}
	if a.DeclineReason == nil || *a.DeclineReason != DeclineInternationalDisabled {
		t.Fatalf("a naira card abroad = %+v, want international_disabled", a)
	}
	mustOK(f.svc.UpdateControls(c.ctx, naira.card.ID, Update{International: ptr(true)}))
	a, err = f.svc.Authorize(t.Context(), abroad(naira, money.New(10_00, money.USD)))
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != AuthAuthorized || a.AmountMinor != 10_00 || a.AmountCurrency != "USD" || a.BillingMinor != 16_240_00 || a.BillingCurrency != "NGN" {
		t.Fatalf("converted charge = %+v, want $10.00 billed as ₦16,240.00", a)
	}
	if _, avail := f.available(c.ngn); avail != 100_000_00-16_240_00 {
		t.Fatalf("available = %d", avail)
	}

	// A dollar card charged in naira is billed in dollars, and a charge the wallet cannot
	// cover once converted is declined.
	dollar := f.issue(c, IssueRequest{AccountID: c.usd, Type: TypeStandard})
	home := func(amount money.Money) ChargeRequest { return dollar.charge(amount, ChannelOnline) }
	a, err = f.svc.Authorize(t.Context(), home(money.New(16_240_00, money.NGN)))
	if err != nil || a.Status != AuthAuthorized || a.BillingMinor != 10_31 || a.BillingCurrency != "USD" {
		t.Fatalf("naira charge on a dollar card = %+v, %v", a, err)
	}
	a, err = f.svc.Authorize(t.Context(), home(money.New(200_000_00, money.NGN)))
	if err != nil || a.DeclineReason == nil || *a.DeclineReason != DeclineInsufficientFunds {
		t.Fatalf("charge beyond the wallet = %+v, %v", a, err)
	}
}

func TestForeignChargeWithoutRatesIsRefusedNotDeclined(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	f.svc.rates = nil
	c := f.customer(100_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})
	mustOK(f.svc.UpdateControls(c.ctx, card.card.ID, Update{International: ptr(true)}))
	_, err := f.svc.Authorize(t.Context(), card.charge(money.New(10_00, money.USD), ChannelOnline))
	wantProblem(t, err, "rates_unavailable")
	var n int
	if err := f.pool.QueryRow(t.Context(), `SELECT count(*) FROM card_authorizations`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d authorizations recorded without a price, err %v", n, err)
	}
}
