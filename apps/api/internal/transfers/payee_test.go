package transfers

import (
	"errors"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

func nemQuery(q string) api.PayeeQuery {
	var out api.PayeeQuery
	if err := out.FromNemPayeeQuery(api.NemPayeeQuery{Kind: "nem", Query: q}); err != nil {
		panic(err)
	}
	return out
}

func bankQuery(code, number, expected string) api.PayeeQuery {
	var out api.PayeeQuery
	q := api.BankPayeeQuery{Kind: "bank", BankCode: code, AccountNumber: number}
	if expected != "" {
		q.ExpectedName = &expected
	}
	if err := out.FromBankPayeeQuery(q); err != nil {
		panic(err)
	}
	return out
}

func TestResolvePayee(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	tolu := f.customer("Tolu", "tolu", 0)
	ada := f.customer("Ada", "ada", 0)

	t.Run("a Nem user by account number or @nemtag", func(t *testing.T) {
		for _, q := range []string{ada.number, " " + ada.number + " ", "@ada"} {
			got, err := f.svc.ResolvePayee(tolu.ctx, nemQuery(q))
			if err != nil {
				t.Fatalf("%q: %v", q, err)
			}
			if got.Kind != api.ResolvedPayeeKindNem || got.Name != "Ada Test" || *got.UserId != ada.id ||
				got.AccountNumber != ada.number || got.BankCode != accounts.BankCode || got.NameMatch != nil {
				t.Fatalf("%q resolved to %+v", q, got)
			}
		}
	})

	t.Run("a Nem account by Nem's bank code runs Confirmation of Payee too", func(t *testing.T) {
		got, err := f.svc.ResolvePayee(tolu.ctx, bankQuery(accounts.BankCode, ada.number, "ada test"))
		if err != nil || got.Kind != api.ResolvedPayeeKindNem || got.NameMatch == nil || got.NameMatch.Result != "match" {
			t.Fatalf("got %+v, %v", got, err)
		}
	})

	t.Run("another bank by name enquiry, with the name compared", func(t *testing.T) {
		for expected, want := range map[string]api.NameMatchResult{
			"Chidi Okonkwo": "match", "Chidi Okonkow": "close_match", "Bola Tinubu": "no_match",
		} {
			got, err := f.svc.ResolvePayee(tolu.ctx, bankQuery("058", "0123456789", expected))
			if err != nil {
				t.Fatal(err)
			}
			if got.Kind != api.ResolvedPayeeKindBank || got.Name != "Chidi Okonkwo" || got.BankName != "Guaranty Trust Bank" ||
				got.UserId != nil || got.IsSavedBeneficiary || got.NameMatch.Result != want || *got.NameMatch.ExpectedName != expected {
				t.Fatalf("%q: %+v, match %+v", expected, got, got.NameMatch)
			}
		}
		// No name typed: the customer still sees who it is, with no verdict.
		if got, err := f.svc.ResolvePayee(tolu.ctx, bankQuery("058", "0123456789", "")); err != nil || got.NameMatch != nil {
			t.Fatalf("no name: %+v, %v", got, err)
		}
	})

	for name, tc := range map[string]struct {
		q    api.PayeeQuery
		code string
	}{
		"unknown @nemtag":         {nemQuery("@nobody"), "account_not_found"},
		"unknown Nem number":      {nemQuery("0000014579"), "account_not_found"},
		"yourself":                {nemQuery("@tolu"), problem.CodeValidationFailed},
		"your own number":         {bankQuery(accounts.BankCode, tolu.number, ""), problem.CodeValidationFailed},
		"a bank not in the list":  {bankQuery("999", "0123456789", ""), problem.CodeValidationFailed},
		"no account at that bank": {bankQuery("044", "1234560000", ""), "account_not_found"},
	} {
		_, err := f.svc.ResolvePayee(tolu.ctx, tc.q)
		var p *problem.Error
		if !errors.As(err, &p) || p.Code != tc.code {
			t.Errorf("%s: %v, want %s", name, err, tc.code)
		}
	}
}

func TestBanksListIsSortedWithNem(t *testing.T) {
	t.Parallel()
	bs := Banks()
	var nem bool
	for i, b := range bs {
		if i > 0 && bs[i-1].Name > b.Name {
			t.Fatalf("%q before %q", bs[i-1].Name, b.Name)
		}
		nem = nem || b.Code == accounts.BankCode
	}
	if !nem || len(bs) < 20 {
		t.Fatalf("banks = %d, Nem listed %v", len(bs), nem)
	}
}
