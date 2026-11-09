package partners

import (
	"context"
	"errors"
	"testing"
)

func TestBanksAreSortedAndUnique(t *testing.T) {
	t.Parallel()
	bs := Banks()
	seen := map[string]bool{}
	for i, b := range bs {
		if seen[b.Code] {
			t.Fatalf("bank code %s listed twice", b.Code)
		}
		seen[b.Code] = true
		if i > 0 && bs[i-1].Name > b.Name {
			t.Fatalf("%q is listed before %q", bs[i-1].Name, b.Name)
		}
	}
	if _, ok := BankByCode(NemBankCode); !ok {
		t.Fatal("Nem Bank is missing from the directory")
	}
}

func TestSandboxNameEnquiry(t *testing.T) {
	t.Parallel()
	nip := NewSandboxNIP()
	tests := []struct {
		name, bank, number, want string
		notFound                 bool
	}{
		// The same names the mock bank's externalAccountName gives, so demos agree.
		{name: "a seeded account", bank: "058", number: "0123456789", want: "Chidi Okonkwo"},
		{name: "a generated account", bank: "044", number: "1234567890", want: "Damilola Bello"},
		{name: "another generated account", bank: "057", number: "5551234567", want: "Halima Ibe"},
		{name: "numbers ending 0000 do not exist", bank: "044", number: "1234560000", notFound: true},
		{name: "not ten digits", bank: "044", number: "12345", notFound: true},
		{name: "unknown bank", bank: "999", number: "1234567890", notFound: true},
		{name: "Nem is not on the interbank rail", bank: NemBankCode, number: "1234567890", notFound: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := nip.NameEnquiry(context.Background(), tt.bank, tt.number)
			if tt.notFound {
				if !errors.Is(err, ErrAccountNotFound) {
					t.Fatalf("err = %v, want ErrAccountNotFound", err)
				}
				return
			}
			if err != nil || got.Name != tt.want {
				t.Fatalf("NameEnquiry = %q, %v; want %q", got.Name, err, tt.want)
			}
		})
	}
}
