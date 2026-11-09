// Package cop is Confirmation of Payee (TRF-3): before money leaves for another bank, the
// name the customer typed is compared with the name the bank holds on the account, so a
// mistyped account number or a scammer's "new account details" gets a warning first.
//
// Names are compared word by word with Jaro-Winkler, which forgives the slips people make
// when typing a name (transposed or missing letters) and rewards a shared start, so
// "Tolu" scores close to "Tolulope". Word order, case, punctuation and titles are ignored.
package cop

import (
	"math"
	"strings"
	"unicode"
)

// Result is the contract NameMatch.result.
type Result string

// The three outcomes the app shows.
const (
	Match      Result = "match"
	CloseMatch Result = "close_match"
	NoMatch    Result = "no_match"
)

// Thresholds on the confidence. A match also needs every word typed to be on the account
// exactly, so a single typo is shown as close and the customer checks the real name
// rather than being waved through.
const (
	MatchAt      = 0.98
	CloseMatchAt = 0.80
)

// Outcome is a comparison's verdict and how sure it is (0 to 1, two decimals).
type Outcome struct {
	Result     Result
	Confidence float64
}

// Compare scores expected (what the customer typed) against actual (the account name).
func Compare(expected, actual string) Outcome {
	a, b := words(expected), words(actual)
	if len(a) == 0 || len(b) == 0 {
		return Outcome{Result: NoMatch, Confidence: 0}
	}
	// precision: is every word they typed on the account? recall: is the account's name
	// covered by what they typed? A missing middle name costs a little, a wrong surname a
	// lot, so precision carries most of the weight.
	precision, recall := coverage(a, b), coverage(b, a)
	c := math.Round((0.75*precision+0.25*recall)*100) / 100
	switch {
	case c >= MatchAt && precision == 1:
		return Outcome{Result: Match, Confidence: c}
	case c >= CloseMatchAt:
		return Outcome{Result: CloseMatch, Confidence: c}
	default:
		return Outcome{Result: NoMatch, Confidence: c}
	}
}

// coverage is the mean, over the words of from, of each word's best score among to.
func coverage(from, to []string) float64 {
	var sum float64
	for _, w := range from {
		best := 0.0
		for _, u := range to {
			best = math.Max(best, JaroWinkler(w, u))
		}
		sum += best
	}
	return sum / float64(len(from))
}

// titles are dropped before comparing: banks rarely hold them, customers often type them.
var titles = map[string]bool{
	"mr": true, "mrs": true, "ms": true, "miss": true, "dr": true, "prof": true, "engr": true,
	"chief": true, "alhaji": true, "alhaja": true, "pastor": true, "barr": true, "sir": true,
}

// words lowercases the name and splits it into letter-only words, without titles.
func words(name string) []string {
	fields := strings.FieldsFunc(strings.ToLower(name), func(r rune) bool { return !unicode.IsLetter(r) })
	out := fields[:0]
	for _, f := range fields {
		if !titles[f] {
			out = append(out, f)
		}
	}
	return out
}

// JaroWinkler is the Jaro-Winkler similarity of a and b, from 0 (nothing alike) to 1
// (identical), with the standard prefix scale 0.1 over at most four leading characters.
func JaroWinkler(a, b string) float64 {
	s, t := []rune(a), []rune(b)
	j := jaro(s, t)
	prefix := 0
	for prefix < min(4, len(s), len(t)) && s[prefix] == t[prefix] {
		prefix++
	}
	return j + float64(prefix)*0.1*(1-j)
}

// jaro counts characters that agree within a window of half the longer length, then the
// transpositions among them.
func jaro(s, t []rune) float64 {
	if len(s) == 0 && len(t) == 0 {
		return 1
	}
	if len(s) == 0 || len(t) == 0 {
		return 0
	}
	window := max(max(len(s), len(t))/2-1, 0)
	sm, tm := make([]bool, len(s)), make([]bool, len(t))
	matches := 0
	for i := range s {
		for k := max(0, i-window); k < min(len(t), i+window+1); k++ {
			if !tm[k] && s[i] == t[k] {
				sm[i], tm[k] = true, true
				matches++
				break
			}
		}
	}
	if matches == 0 {
		return 0
	}
	transposed, k := 0, 0
	for i := range s {
		if !sm[i] {
			continue
		}
		for !tm[k] {
			k++
		}
		if s[i] != t[k] {
			transposed++
		}
		k++
	}
	m := float64(matches)
	return (m/float64(len(s)) + m/float64(len(t)) + (m-float64(transposed)/2)/m) / 3
}
