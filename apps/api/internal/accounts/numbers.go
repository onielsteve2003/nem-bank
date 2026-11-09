package accounts

import (
	"errors"
	"fmt"
	"strconv"
)

// The demo bank's identity. The code is fictitious (CBN six-digit codes in the 090xxx range
// belong to microfinance banks), the same one the app's mock bank uses
// (apps/mobile/src/data/mock/directory.ts NEM_BANK).
const (
	BankCode = "090999"
	BankName = "Nem Bank (demo)"
)

// Simulated foreign receiving details (ACC-2), as the mock bank shows them. They are
// labelled "Demo details" in the app; no real account behind them can receive money.
const (
	partnerBankName = "Nem Sandbox Partner Bank (demo)"
	usRoutingNumber = "021000000"
	ukSortCode      = "04-00-00"
	euBankCode      = "50000000" // German Bankleitzahl slot in the IBAN's BBAN
	euBIC           = "NEMSDEFFXXX"
	walletPrefix    = "84"
)

var errBadDigits = errors.New("accounts: expected decimal digits")

// nubanWeights is the CBN NUBAN weighting, repeated over the 15 digits of a six-digit
// institution code followed by the nine-digit serial.
var nubanWeights = [15]int{3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3}

// NubanCheckDigit returns the tenth digit of a NUBAN account number, per the CBN's revised
// standard (2020): the institution code is widened to six digits (a three-digit bank
// code gains a "000" prefix, a five-digit one a "9"), then the weighted sum of code and
// serial gives check = (10 − sum mod 10) mod 10.
func NubanCheckDigit(bankCode, serial string) (int, error) {
	switch len(bankCode) {
	case 3:
		bankCode = "000" + bankCode
	case 5:
		bankCode = "9" + bankCode
	case 6:
	default:
		return 0, fmt.Errorf("accounts: bank code %q must have 3, 5 or 6 digits", bankCode)
	}
	if len(serial) != 9 {
		return 0, fmt.Errorf("accounts: NUBAN serial %q must have 9 digits", serial)
	}
	digits := bankCode + serial
	sum := 0
	for i := range len(digits) {
		d := digits[i]
		if d < '0' || d > '9' {
			return 0, errBadDigits
		}
		sum += int(d-'0') * nubanWeights[i]
	}
	return (10 - sum%10) % 10, nil
}

// ValidNuban reports whether number is a well-formed NUBAN at the bank.
func ValidNuban(bankCode, number string) bool {
	if len(number) != 10 {
		return false
	}
	check, err := NubanCheckDigit(bankCode, number[:9])
	return err == nil && int(number[9]-'0') == check
}

// nubanFor builds the account number for a serial from the nuban_serial sequence.
func nubanFor(serial int64) (string, error) {
	s := fmt.Sprintf("%09d", serial)
	check, err := NubanCheckDigit(BankCode, s)
	if err != nil {
		return "", err
	}
	return s + strconv.Itoa(check), nil
}

// walletNumberFor builds a wallet's simulated ten-digit number from its serial.
func walletNumberFor(serial int64) string { return fmt.Sprintf("%s%08d", walletPrefix, serial) }

// germanIBAN builds a structurally valid German IBAN (DE, two check digits, eight-digit
// bank code, ten-digit account) with real ISO 13616 mod-97 check digits, so the number
// passes any IBAN validator a reviewer pastes it into.
func germanIBAN(account string) string {
	bban := euBankCode + account
	return "DE" + fmt.Sprintf("%02d", 98-mod97(bban+"DE00")) + bban
}

// mod97 computes the ISO 7064 remainder of an IBAN rearranged for checking, with letters
// expanded to two digits (A = 10 … Z = 35), one digit at a time so it never overflows.
func mod97(s string) int {
	r := 0
	for i := range len(s) {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			v := int(c-'A') + 10
			r = (r*100 + v) % 97
			continue
		}
		r = (r*10 + int(c-'0')) % 97
	}
	return r
}

// validIBAN reports whether an IBAN's check digits are right (remainder 1).
func validIBAN(iban string) bool {
	if len(iban) < 5 {
		return false
	}
	return mod97(iban[4:]+iban[:4]) == 1
}
