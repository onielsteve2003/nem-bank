package partners

import (
	"context"
	"fmt"
)

// AccountName is a name enquiry's answer: the name the receiving bank holds.
type AccountName struct {
	BankCode      string
	AccountNumber string
	Name          string
}

// SandboxNIP simulates the NIBSS Instant Payment rail with no real money or network.
type SandboxNIP struct{}

// NewSandboxNIP returns the sandbox rail.
func NewSandboxNIP() *SandboxNIP { return &SandboxNIP{} }

// Name identifies the partner in logs, callbacks and the ledger.
func (*SandboxNIP) Name() string { return "sandbox_nip" }

// NameEnquiry asks the receiving bank whose account this is (NIP name enquiry).
func (*SandboxNIP) NameEnquiry(_ context.Context, bankCode, accountNumber string) (AccountName, error) {
	if _, ok := BankByCode(bankCode); !ok || bankCode == NemBankCode {
		return AccountName{}, fmt.Errorf("%w: bank %s", ErrAccountNotFound, bankCode)
	}
	name, err := sandboxAccountName(accountNumber)
	if err != nil {
		return AccountName{}, err
	}
	return AccountName{BankCode: bankCode, AccountNumber: accountNumber, Name: name}, nil
}
