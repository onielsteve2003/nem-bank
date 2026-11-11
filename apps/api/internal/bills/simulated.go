package bills

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// Simulated is the default biller (BILL-4): a fixed catalog and deterministic behaviour, so
// demos and tests can reach every outcome without a third party.
//
// Magic numbers, so the error paths can be shown:
//   - a meter or smartcard ending in 0000 does not exist (validation fails);
//   - any customer number ending in 9999 is refused at purchase (the payment is reversed).
type Simulated struct{}

var _ Biller = Simulated{}

// tariffKobo is the demo electricity tariff, ₦225 per kWh.
const tariffKobo = 225_00

// Name implements Biller.
func (Simulated) Name() string { return "simulated" }

func naira(n int64) money.Money { return money.New(n*100, money.NGN) }

var networks = []struct{ id, name string }{
	{MTN, "MTN"}, {Airtel, "Airtel"}, {Glo, "Glo"}, {NineMobile, "9mobile"},
}

var catalog = buildCatalog()

func buildCatalog() []Info {
	var out []Info
	for _, n := range networks {
		out = append(out, Info{ID: n.id + "-airtime", Category: Airtime, Name: n.name + " Airtime", Network: n.id, MinAmount: naira(50)})
	}
	for _, n := range networks {
		out = append(out, Info{ID: n.id + "-data", Category: Data, Name: n.name + " Data", Network: n.id, HasProducts: true})
	}
	for _, e := range [][2]string{
		{"ikeja-electric-prepaid", "Ikeja Electric (prepaid)"},
		{"eko-electric-prepaid", "Eko Electric (prepaid)"},
		{"abuja-electric-prepaid", "Abuja Electric (prepaid)"},
	} {
		out = append(out, Info{ID: e[0], Category: Electricity, Name: e[1], RequiresValidation: true, MinAmount: naira(1_000)})
	}
	for _, e := range [][2]string{{"dstv", "DStv"}, {"gotv", "GOtv"}, {"startimes", "StarTimes"}} {
		out = append(out, Info{ID: e[0], Category: CableTV, Name: e[1], RequiresValidation: true, HasProducts: true})
	}
	return out
}

func product(id, name string, major int64, validity int) Product {
	return Product{ID: id, Name: name, Amount: naira(major), ValidityDays: validity}
}

var dataPlans = []Product{
	product("1gb-1d", "1GB, 1 day", 500, 1),
	product("2gb-7d", "2GB, 7 days", 1_000, 7),
	product("10gb-30d", "10GB, 30 days", 5_000, 30),
	product("25gb-30d", "25GB, 30 days", 10_000, 30),
}

var cablePlans = map[string][]Product{
	"dstv":      {product("padi", "DStv Padi", 4_400, 30), product("compact", "DStv Compact", 19_000, 30), product("premium", "DStv Premium", 44_500, 30)},
	"gotv":      {product("jolli", "GOtv Jolli", 5_800, 30), product("max", "GOtv Max", 8_500, 30)},
	"startimes": {product("basic", "Nova Basic", 2_600, 30), product("classic", "Classic", 6_000, 30)},
}

func find(billerID string) (Info, error) {
	for _, b := range catalog {
		if b.ID == billerID {
			return b, nil
		}
	}
	return Info{}, ErrUnknownBiller
}

// Billers implements Biller.
func (Simulated) Billers(context.Context) ([]Info, error) {
	return append([]Info(nil), catalog...), nil
}

// Products implements Biller. Plans are already listed cheapest first.
func (Simulated) Products(_ context.Context, billerID string) ([]Product, error) {
	b, err := find(billerID)
	if err != nil {
		return nil, err
	}
	switch b.Category {
	case Data:
		return append([]Product(nil), dataPlans...), nil
	case CableTV:
		return append([]Product(nil), cablePlans[b.ID]...), nil
	default:
		return nil, nil
	}
}

// names are the account holders the simulator makes up; a number always maps to the same one.
var names = []string{
	"ADEBAYO OLUWASEUN", "CHIOMA NWANKWO", "IBRAHIM MUSA", "FUNMILAYO BALOGUN",
	"EMEKA OKAFOR", "AISHA YUSUF", "TUNDE ADEYEMI", "NGOZI EZE",
}

// Validate implements Biller. Meters have 11 digits and smartcards 10.
func (Simulated) Validate(_ context.Context, billerID, customerID string) (Customer, error) {
	b, err := find(billerID)
	if err != nil {
		return Customer{}, err
	}
	if !b.RequiresValidation {
		return Customer{ID: customerID}, nil
	}
	want := 10
	if b.Category == Electricity {
		want = 11
	}
	if !allDigits(customerID) || len(customerID) != want || strings.HasSuffix(customerID, "0000") {
		return Customer{}, ErrCustomerNotFound
	}
	sum := sha256.Sum256([]byte(customerID))
	c := Customer{ID: customerID, Name: names[int(sum[0])%len(names)]}
	switch b.Category {
	case Electricity:
		c.Address = "12 Admiralty Way, Lekki Phase 1"
	case CableTV:
		// Everyone is on the second plan, so "upgrade" has something to compare with.
		if plans := cablePlans[b.ID]; len(plans) > 1 {
			c.CurrentPlan = plans[1].Name
		}
	}
	return c, nil
}

// Vend implements Biller. The token is derived from the reference, so asking again with the
// same reference returns the same token, as a real biller's idempotent retry does.
func (Simulated) Vend(_ context.Context, req VendRequest) (VendResult, error) {
	b, err := find(req.BillerID)
	if err != nil {
		return VendResult{}, err
	}
	if strings.HasSuffix(req.CustomerID, "9999") {
		return VendResult{}, ErrVendRejected
	}
	if b.Category != Electricity {
		return VendResult{}, nil
	}
	sum := sha256.Sum256([]byte("simulated token " + req.Reference))
	groups := make([]string, 5)
	for i := range groups {
		// Four digits per group: two bytes, reduced. The slight bias is irrelevant for a demo token.
		n := (int(sum[2*i])<<8 | int(sum[2*i+1])) % 10_000
		groups[i] = fmt.Sprintf("%04d", n)
	}
	// Units are rounded down to a tenth of a kWh: the customer is never shown more than they paid for.
	tenths := req.Amount.Amount() * 10 / tariffKobo
	return VendResult{Token: strings.Join(groups, "-"), Units: fmt.Sprintf("%d.%d kWh", tenths/10, tenths%10)}, nil
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
