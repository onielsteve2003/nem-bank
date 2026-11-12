package demo

import (
	"cmp"
	"context"
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// historyMonths is how far back a persona's story starts (AUTH-11: six months).
const historyMonths = 6

// naira is kobo for n naira.
func naira(n int64) int64 { return n * 100 }

// spend is something a persona pays for now and then.
type spend struct {
	merchant, category, kind string
	// min and max are kobo; a fixed price has min == max.
	min, max int64
	// perMonth is the usual count in a month; day > 0 pins a monthly charge to that day.
	perMonth int
	day      int
	// bank names the receiving bank of a transfer.
	bank string
}

// spends is the catalogue every persona draws from; a persona's scale shrinks or grows it.
var spends = []spend{
	{merchant: "Chicken Republic", category: "food", kind: "card_payment", min: naira(3500), max: naira(9000), perMonth: 4},
	{merchant: "Shoprite Lekki", category: "groceries", kind: "card_payment", min: naira(15000), max: naira(42000), perMonth: 2},
	{merchant: "Bolt", category: "transport", kind: "card_payment", min: naira(1800), max: naira(6500), perMonth: 6},
	{merchant: "Uber", category: "transport", kind: "card_payment", min: naira(2500), max: naira(8000), perMonth: 2},
	{merchant: "MTN Airtime", category: "airtime_data", kind: "bill_payment", min: naira(1000), max: naira(5000), perMonth: 2},
	{merchant: "Netflix", category: "subscriptions", kind: "card_payment", min: naira(4400), max: naira(4400), perMonth: 1, day: 12},
	{merchant: "Spotify", category: "subscriptions", kind: "card_payment", min: naira(1300), max: naira(1300), perMonth: 1, day: 5},
	{merchant: "Ikeja Electric", category: "bills_utilities", kind: "bill_payment", min: naira(8000), max: naira(20000), perMonth: 1},
	{merchant: "Jumia", category: "shopping", kind: "card_payment", min: naira(12000), max: naira(55000), perMonth: 1},
	{merchant: "HealthPlus Pharmacy", category: "health", kind: "card_payment", min: naira(3000), max: naira(14000), perMonth: 1},
	{merchant: "Folake Adebayo", category: "family", kind: "transfer_out", min: naira(20000), max: naira(45000), perMonth: 1, bank: "GTBank"},
}

// persona is one of the four seeded customers (contract enum).
type persona struct {
	first, last, tagBase string
	born                 time.Time
	tier                 int16
	kycStatus            string
	employer             string
	salary               int64
	salaryDay            int
	// rent and save are fixed monthly transfers out (rent the day after pay, savings after that).
	rent, save int64
	// cap is the NGN balance the persona's KYC tier allows; 0 means none.
	cap int64
	// usd is the persona's dollar income: each payment lands in a USD wallet in the given month
	// of the story (1 is the first month after the story starts). Empty means no USD wallet.
	usd []usdPayment
	// scale multiplies how much and how often this persona spends.
	scale float64
}

var personas = map[string]persona{
	"tolu": {
		first: "Tolulope", last: "Adebayo", tagBase: "tolu",
		born: date(1996, 3, 14), tier: 2, employer: "Paystack Payments Ltd", salary: naira(420000), salaryDay: 25, scale: 1, rent: naira(150000), save: naira(55000), cap: naira(500000),
		usd: []usdPayment{{1, 10, 65000, "Upwork Escrow Inc"}, {3, 12, 48000, "Toptal Payments"}, {5, 9, 82000, "Upwork Escrow Inc"}},
	},
	"mama_ngozi": {
		first: "Ngozi", last: "Okafor", tagBase: "mamangozi",
		born: date(1974, 8, 2), tier: 1, employer: "Okafor Provisions", salary: naira(150000), salaryDay: 1, scale: 0.35, save: naira(60000), cap: naira(300000),
	},
	"emeka": {
		first: "Emeka", last: "Nwosu", tagBase: "emeka",
		born: date(1989, 11, 21), tier: 3, kycStatus: "approved", employer: "Flutterwave Technology", salary: naira(950000), salaryDay: 28, scale: 1.8, rent: naira(300000), save: naira(150000),
		usd: []usdPayment{{2, 15, 150000, "Stripe Payouts"}, {4, 15, 150000, "Stripe Payouts"}},
	},
	"bisi": {
		first: "Bisola", last: "Alade", tagBase: "bisi",
		born: date(2002, 5, 9), tier: 2, employer: "Lagos State Internship Scheme", salary: naira(110000), salaryDay: 20, scale: 0.4, save: naira(15000), cap: naira(500000),
	},
}

func date(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

// event is one dated movement before it is written.
type event struct {
	at          time.Time
	credit      bool
	amount      int64
	txType      string
	category    string
	name, bank  string
	narrationIn string
}

// plan lays out a persona's history: an opening deposit, a salary each month and the
// spending between, in date order. It is deterministic per persona, so every demo of
// Tolu tells the same story. Spending that the balance cannot cover is dropped, because
// a customer's balance never goes negative.
func (p persona) plan(now time.Time, key string) []event {
	h := fnv.New64a()
	_, _ = h.Write([]byte(key))
	// Deterministic on purpose, so a persona tells the same story every time; not a secret.
	rng := rand.New(rand.NewPCG(h.Sum64(), 0x6e656d)) //nolint:gosec // demo data, not security
	start := now.AddDate(0, -historyMonths, 0)

	events := []event{{
		at: start.Add(9 * time.Hour), credit: true, amount: p.salary / 8, txType: "transfer_in", category: "transfers",
		name: "Nem Bank", narrationIn: "Opening deposit",
	}}
	for m := 0; m <= historyMonths; m++ {
		first := time.Date(start.Year(), start.Month()+time.Month(m), 1, 0, 0, 0, 0, time.UTC)
		last := first.AddDate(0, 1, -1).Day()
		at := func(day int) time.Time {
			day = min(max(day, 1), last)
			return first.AddDate(0, 0, day-1).Add(time.Duration(8+rng.IntN(12))*time.Hour + time.Duration(rng.IntN(60))*time.Minute)
		}
		events = append(events, event{
			at: at(p.salaryDay), credit: true, amount: p.salary, txType: "transfer_in", category: "salary_income",
			name: p.employer, narrationIn: "Salary " + first.Format("January 2006"),
		})
		if p.rent > 0 {
			events = append(events, event{at: at(p.salaryDay + 1), amount: p.rent, txType: "transfer_out", category: "rent_housing", name: "Landlord - Mr Bakare", bank: "Access Bank"})
		}
		if p.save > 0 {
			events = append(events, event{at: at(p.salaryDay + 2), amount: p.save, txType: "transfer_out", category: "savings", name: "Cowrywise Savings", bank: "Providus Bank"})
		}
		for _, s := range spends {
			n := s.perMonth
			if s.day == 0 {
				n = int(float64(n)*p.scale + rng.Float64())
			}
			for range n {
				day := s.day
				if day == 0 {
					day = 1 + rng.IntN(28)
				}
				amount := s.min
				if s.max > s.min {
					amount = s.min + rng.Int64N(s.max-s.min+1)
					if s.day == 0 {
						amount = int64(float64(amount)*(0.6+0.4*p.scale)) / 100 * 100
					}
				}
				events = append(events, event{
					at: at(day), amount: amount, txType: s.kind, category: s.category, name: s.merchant, bank: s.bank,
				})
			}
		}
	}
	slices.SortStableFunc(events, func(a, b event) int { return cmp.Compare(a.at.UnixNano(), b.at.UnixNano()) })

	var balance int64
	kept := events[:0]
	for _, e := range events {
		switch {
		case e.at.After(now):
			continue
		case e.credit && p.cap > 0 && balance+e.amount > p.cap:
			continue // the tier's balance cap would have refused it
		case e.credit:
			balance += e.amount
		case e.amount <= balance:
			balance -= e.amount
		default:
			continue
		}
		kept = append(kept, e)
	}
	return kept
}

// seed writes a persona's history for a new customer, in the sign-in transaction, as real
// ledger entries against the demo funding account, so the balance, statements and insights
// all agree with the ledger.
func (p persona) seed(ctx context.Context, tx pgx.Tx, userID uuid.UUID, now time.Time) error {
	acc, err := accountsdb.New(tx).GetCustomerAccountByCurrency(ctx, accountsdb.GetCustomerAccountByCurrencyParams{
		UserID: userID, Currency: string(money.NGN),
	})
	if err != nil {
		return fmt.Errorf("demo account: %w", err)
	}
	bank, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, string(money.NGN))
	if err != nil {
		return err
	}
	for i, e := range p.plan(now, p.last) {
		amount := money.New(e.amount, money.NGN)
		ref := fmt.Sprintf("DEMO-%s-%03d", strings.ToUpper(userID.String()[24:32]), i)
		legs := []ledger.Leg{ledger.Debit(acc.AccountID, amount), ledger.Credit(bank.ID, amount)}
		direction, narration := "debit", "Payment to "+e.name
		if e.credit {
			legs = []ledger.Leg{ledger.Debit(bank.ID, amount), ledger.Credit(acc.AccountID, amount)}
			direction, narration = "credit", e.narrationIn
		} else if e.txType == "transfer_out" {
			narration = "Transfer to " + e.name
		}
		posted, err := ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: ref, Legs: legs})
		if err != nil {
			return fmt.Errorf("post demo history: %w", err)
		}
		cp := api.Counterparty{Name: e.name}
		if e.bank != "" {
			cp.BankName = &e.bank
		}
		if _, err := accounts.Record(ctx, tx, accounts.Line{
			UserID: userID, AccountID: acc.AccountID, Type: e.txType, Direction: direction, Status: "completed",
			Amount: amount, Entry: &posted, Narration: narration, Reference: ref, Category: e.category,
			Counterparty: cp, At: e.at,
		}); err != nil {
			return fmt.Errorf("record demo history: %w", err)
		}
	}
	return nil
}

// usdPayment is one dollar payment in a persona's story: the month after the story starts, the
// day of that month, the cents and who paid.
type usdPayment struct {
	month, day int
	cents      int64
	payer      string
}

// seedUSD opens the persona's USD wallet and fills it with their dollar income, as real ledger
// entries from the demo funding account. A persona with no dollar income gets no wallet.
func (p persona) seedUSD(ctx context.Context, tx pgx.Tx, userID uuid.UUID, now time.Time) error {
	if len(p.usd) == 0 {
		return nil
	}
	wallet, err := accounts.OpenWalletTx(ctx, tx, userID, money.USD)
	if err != nil {
		return fmt.Errorf("demo usd wallet: %w", err)
	}
	bank, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, string(money.USD))
	if err != nil {
		return err
	}
	start := now.AddDate(0, -historyMonths, 0)
	for i, pay := range p.usd {
		at := time.Date(start.Year(), start.Month()+time.Month(pay.month), pay.day, 11, 0, 0, 0, time.UTC)
		if at.After(now) {
			continue
		}
		amount := money.New(pay.cents, money.USD)
		ref := fmt.Sprintf("DEMO-%s-USD%02d", strings.ToUpper(userID.String()[24:32]), i)
		posted, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "demo_funding", Reference: ref,
			Legs: []ledger.Leg{ledger.Debit(bank.ID, amount), ledger.Credit(wallet.AccountID, amount)},
		})
		if err != nil {
			return fmt.Errorf("post demo dollars: %w", err)
		}
		if _, err := accounts.Record(ctx, tx, accounts.Line{
			UserID: userID, AccountID: wallet.AccountID, Type: "transfer_in", Direction: "credit", Status: "completed",
			Amount: amount, Entry: &posted, Narration: "Freelance payment", Reference: ref, Category: "salary_income",
			Counterparty: api.Counterparty{Name: pay.payer}, At: at,
		}); err != nil {
			return fmt.Errorf("record demo dollars: %w", err)
		}
	}
	return nil
}
