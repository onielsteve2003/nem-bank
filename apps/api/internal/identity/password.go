package identity

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Password rules (AUTH-3), a Go port of checkPassword in packages/shared/src/password.ts.
// The app's strength meter runs the TypeScript copy; this one is the authority. Keep the
// two in step: the shared test vectors are repeated in password_test.go.

const (
	passwordMinLength = 10
	passwordMaxLength = 128
)

// breachedRoots top every breach list, plus the local favourites.
var breachedRoots = []string{
	"password", "passw0rd", "qwerty", "azerty", "asdfgh", "zxcvbn", "letmein", "welcome",
	"iloveyou", "admin", "monkey", "dragon", "football", "baseball", "sunshine", "princess",
	"master", "shadow", "trustno1", "abc123", "nigeria", "naija", "lagos", "abuja", "jesus",
	"blessed", "godisgood", "nembank",
}

var sequences = []string{"abcdefghijklmnopqrstuvwxyz", "01234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"}

// unLeet undoes leetspeak so "P@ssw0rd" is caught as "password".
var unLeet = strings.NewReplacer("@", "a", "4", "a", "3", "e", "1", "i", "!", "i", "0", "o", "$", "s", "5", "s", "7", "t")

var classes = []*regexp.Regexp{
	regexp.MustCompile(`[a-z]`), regexp.MustCompile(`[A-Z]`),
	regexp.MustCompile(`\d`), regexp.MustCompile(`[^A-Za-z0-9]`),
}

// PasswordContext is what an attacker who knows the customer would try first.
type PasswordContext struct {
	FirstName, LastName, Email string
	// DateOfBirth is YYYY-MM-DD.
	DateOfBirth string
}

// CheckPassword returns "" when the password is acceptable, otherwise the first problem
// to fix, worded for the customer.
func CheckPassword(password string, pc PasswordContext) string {
	lower := strings.ToLower(password)
	plain := unLeet.Replace(lower)
	// Length is in UTF-16 code units in the TS copy; runes are close enough and never
	// shorter, so nothing the app accepts is refused here for length.
	length := utf8.RuneCountInString(password)
	var problems []string
	if length < passwordMinLength {
		problems = append(problems, fmt.Sprintf("Use at least %d characters", passwordMinLength))
	}
	if length > passwordMaxLength {
		problems = append(problems, fmt.Sprintf("Use at most %d characters", passwordMaxLength))
	}
	for _, root := range breachedRoots {
		if strings.Contains(lower, root) || strings.Contains(plain, root) {
			problems = append(problems, fmt.Sprintf("Avoid %q: it is in leaked password lists", root))
			break
		}
	}
	for _, part := range personalParts(pc) {
		if strings.Contains(lower, part) || strings.Contains(plain, part) {
			problems = append(problems, "Leave out your name, email and birth year")
			break
		}
	}

	n := 0
	for _, re := range classes {
		if re.MatchString(password) {
			n++
		}
	}
	score := 0
	switch {
	case length >= 16:
		score = 3
	case length >= 12:
		score = 2
	case length >= 10:
		score = 1
	}
	if n >= 3 {
		score++
	}
	if hasTriple(password) || hasSequence(lower) {
		score--
	}
	if len(problems) > 0 {
		return problems[0]
	}
	if score < 2 {
		return "Make it a little stronger"
	}
	return ""
}

func personalParts(pc PasswordContext) []string {
	local, _, _ := strings.Cut(pc.Email, "@")
	year, _, _ := strings.Cut(pc.DateOfBirth, "-")
	var out []string
	for _, p := range []string{pc.FirstName, pc.LastName, local} {
		if p = strings.ToLower(strings.TrimSpace(p)); utf8.RuneCountInString(p) >= 3 {
			out = append(out, p)
		}
	}
	if len(year) >= 3 {
		out = append(out, year)
	}
	return out
}

// hasTriple reports a character repeated three times in a row, like "aaa".
func hasTriple(s string) bool {
	r := []rune(s)
	for i := 2; i < len(r); i++ {
		if r[i] == r[i-1] && r[i] == r[i-2] {
			return true
		}
	}
	return false
}

// hasSequence reports a run of 4+ characters up or down the alphabet, digits or a
// keyboard row.
func hasSequence(lower string) bool {
	for _, row := range sequences {
		rev := reverse(row)
		for i := 0; i+4 <= len(row); i++ {
			if strings.Contains(lower, row[i:i+4]) || strings.Contains(lower, rev[i:i+4]) {
				return true
			}
		}
	}
	return false
}

func reverse(s string) string {
	b := []byte(s)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}
