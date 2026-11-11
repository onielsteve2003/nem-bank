package cards

import (
	"crypto/rand"
	"fmt"
	"math/big"
)

// Test BINs (CARD-7). They carry the look of the networks the app brands them with, but the
// numbers only ever work inside Nem's own processor: nothing else knows them.
const (
	binVerve = "506099" // NGN cards, branded nem_verve
	binVisa  = "453201" // USD cards, branded nem_visa
)

// luhnCheckDigit is the digit that makes partial + digit pass the Luhn check.
func luhnCheckDigit(partial string) int {
	sum := 0
	// Walking from the right, the digit next to the check digit is doubled, then every
	// second one after it.
	for i, double := len(partial)-1, true; i >= 0; i, double = i-1, !double {
		d := int(partial[i] - '0')
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
	}
	return (10 - sum%10) % 10
}

// luhnValid reports whether pan is all digits and passes the Luhn check.
func luhnValid(pan string) bool {
	if len(pan) < 2 {
		return false
	}
	for _, r := range pan {
		if r < '0' || r > '9' {
			return false
		}
	}
	return luhnCheckDigit(pan[:len(pan)-1]) == int(pan[len(pan)-1]-'0')
}

// newPAN is bin + nine random digits + the Luhn check digit: sixteen digits in all.
func newPAN(bin string) (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000_000))
	if err != nil {
		return "", fmt.Errorf("random card number: %w", err)
	}
	partial := fmt.Sprintf("%s%09d", bin, n.Int64())
	return fmt.Sprintf("%s%d", partial, luhnCheckDigit(partial)), nil
}
