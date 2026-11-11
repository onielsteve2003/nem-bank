package cards

import (
	"testing"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/categorize"
)

// A card payment is filed by the merchant dictionary, then by the model when it is confident,
// and only then by the merchant category code; the customer's own rule wins over all three.
func TestCardPaymentsAreFiledBySmartCategories(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	classifier, err := categorize.New()
	if err != nil {
		t.Fatal(err)
	}
	f.svc.categorizer = classifier
	c := f.customer(100_000_00, 0)
	card := f.issue(c, IssueRequest{AccountID: c.ngn, Type: TypeStandard})

	charge := func(name, mcc string) (category, source string, confidence *float32) {
		t.Helper()
		req := card.charge(naira(1_500), ChannelOnline)
		req.Merchant = Merchant{ID: "m_" + uuid.NewString()[:6], Name: name, MCC: mcc, Country: "NG"}
		a, err := f.svc.Authorize(t.Context(), req)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.pool.QueryRow(t.Context(), `SELECT category, category_source, category_confidence FROM transactions WHERE id = $1`,
			*a.TransactionID).Scan(&category, &source, &confidence); err != nil {
			t.Fatal(err)
		}
		return category, source, confidence
	}

	// In the dictionary: the dictionary decides, whatever the MCC says.
	if cat, src, conf := charge("Shoprite Lekki", "5999"); cat != "groceries" || src != "rules" || conf != nil {
		t.Fatalf("dictionary merchant = %s %s %v", cat, src, conf)
	}
	// Not in the dictionary: the model reads the name, and says how sure it is.
	cat, src, conf := charge("Adaobi Chemist Ikeja", "5999")
	if cat != "health" || src != "model" || conf == nil || *conf <= 0 || *conf > 1 {
		t.Fatalf("unseen merchant = %s %s %v", cat, src, conf)
	}
	// Nothing to read: the merchant category code decides.
	if cat, src, conf := charge("0000", "5812"); cat != "food" || src != "rules" || conf != nil {
		t.Fatalf("no opinion = %s %s %v", cat, src, conf)
	}

	// Smart categories off: the MCC alone, never a "model" source.
	f.svc.categorizer = nil
	if cat, src, _ := charge("Adaobi Chemist Ikeja", "5999"); cat != "shopping" || src != "rules" {
		t.Fatalf("model off = %s %s", cat, src)
	}
}
