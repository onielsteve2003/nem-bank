// Package partners is the interbank rail: the banks a customer can pay, and the partners
// that carry money to them. Each partner sits behind one interface, so going live means
// adding an adapter for a licensed provider, not rewriting transfers (PRD §12, ADR-7).
package partners

import (
	"cmp"
	"slices"
)

// Bank is a Nigerian bank with its CBN code.
type Bank struct {
	Code      string
	Name      string
	ShortName string
}

// NemBankCode is Nem's own code in the directory; transfers to it never leave the ledger.
const NemBankCode = "090999"

// banks mirrors the mock bank's directory (apps/mobile/src/data/mock/directory.ts), so the
// app's bank picker shows the same list against either backend.
var banks = []Bank{
	{NemBankCode, "Nem Bank (demo)", "Nem"},
	{"044", "Access Bank", "Access"},
	{"058", "Guaranty Trust Bank", "GTBank"},
	{"057", "Zenith Bank", "Zenith"},
	{"011", "First Bank of Nigeria", "First Bank"},
	{"033", "United Bank for Africa", "UBA"},
	{"070", "Fidelity Bank", "Fidelity"},
	{"214", "First City Monument Bank", "FCMB"},
	{"032", "Union Bank of Nigeria", "Union"},
	{"232", "Sterling Bank", "Sterling"},
	{"035", "Wema Bank", "Wema"},
	{"221", "Stanbic IBTC Bank", "Stanbic"},
	{"050", "Ecobank Nigeria", "Ecobank"},
	{"076", "Polaris Bank", "Polaris"},
	{"082", "Keystone Bank", "Keystone"},
	{"101", "Providus Bank", "Providus"},
	{"301", "Jaiz Bank", "Jaiz"},
	{"999992", "OPay Digital Services", "OPay"},
	{"999991", "PalmPay", "PalmPay"},
	{"50515", "Moniepoint MFB", "Moniepoint"},
	{"50211", "Kuda Microfinance Bank", "Kuda"},
}

// Banks lists the directory sorted by name, as GET /v1/banks returns it.
func Banks() []Bank {
	out := slices.Clone(banks)
	slices.SortFunc(out, func(a, b Bank) int { return cmp.Compare(a.Name, b.Name) })
	return out
}

// BankByCode finds a bank in the directory.
func BankByCode(code string) (Bank, bool) {
	i := slices.IndexFunc(banks, func(b Bank) bool { return b.Code == code })
	if i < 0 {
		return Bank{}, false
	}
	return banks[i], true
}
