package partners

import (
	"errors"
	"strings"
)

// ErrAccountNotFound means the receiving bank has no account with that number.
var ErrAccountNotFound = errors.New("partners: no account with that number at that bank")

// knownAccounts are the other-bank accounts the demo history pays, so their names resolve
// exactly (KNOWN_EXTERNAL in the mock bank).
var knownAccounts = map[string]string{
	"0123456789": "Chidi Okonkwo",
	"2234567890": "Funmi Ade",
	"3034567891": "Ibrahim Musa",
	"3045678912": "Mama Adebayo",
}

var (
	firstNames = []string{"Adaeze", "Babatunde", "Chinedu", "Damilola", "Efosa", "Folake", "Garba", "Halima"}
	lastNames  = []string{"Okafor", "Balogun", "Nnamdi", "Ogunleye", "Bello", "Eze", "Danjuma", "Ibe"}
)

// sandboxAccountName is the sandbox's account directory: a stable, plausible name for any
// ten-digit number at another bank. It is the mock bank's externalAccountName, digit for
// digit, so a demo gives the same name against either backend. Numbers ending in 0000 do
// not exist, so "no such account" can be demoed.
func sandboxAccountName(accountNumber string) (string, error) {
	if len(accountNumber) != 10 || strings.Trim(accountNumber, "0123456789") != "" {
		return "", ErrAccountNotFound
	}
	if name, ok := knownAccounts[accountNumber]; ok {
		return name, nil
	}
	if strings.HasSuffix(accountNumber, "0000") {
		return "", ErrAccountNotFound
	}
	n := 0 // at most 9 × (7^10 − 1)/6 ≈ 4.2e8: no overflow
	for _, d := range accountNumber {
		n = n*7 + int(d-'0')
	}
	return firstNames[n%len(firstNames)] + " " + lastNames[(n/len(firstNames))%len(lastNames)], nil
}
