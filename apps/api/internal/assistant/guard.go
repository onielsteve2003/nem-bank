package assistant

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// ---- PII redaction ----------------------------------------------------------------------

// Vault holds what was swapped out of one request, so a tool argument or the model's reply
// that mentions a placeholder can be turned back into the real value on our side. It lives
// for one request and is never stored.
type Vault struct {
	byToken map[string]string
	byValue map[string]string
	counts  map[string]int
}

// NewVault returns an empty vault.
func NewVault() *Vault {
	return &Vault{byToken: map[string]string{}, byValue: map[string]string{}, counts: map[string]int{}}
}

// The shapes of personal data that must never reach a free-tier model (AI-9). Order matters:
// emails first (they hold @), then card numbers (long digit runs with spaces), then phones
// and plain account-like numbers. Amounts are shorter than 10 digits, so they pass through.
var redactions = []struct {
	kind string
	re   *regexp.Regexp
}{
	{"EMAIL", regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)},
	{"CARD", regexp.MustCompile(`\b(?:\d[ -]?){13,19}\b`)},
	{"PHONE", regexp.MustCompile(`(?:\+234|\b234|\b0)[789][01]\d[ -]?\d{3}[ -]?\d{4}\b`)},
	{"NEMTAG", regexp.MustCompile(`@[A-Za-z0-9_]{3,20}\b`)},
	{"NUMBER", regexp.MustCompile(`\b\d{10,}\b`)}, // NUBAN, BVN, NIN, long references
}

// Redact swaps personal identifiers for placeholders like [ACCOUNT_1]. The same value always
// gets the same placeholder, so the model can still say "the first one".
func (v *Vault) Redact(text string) string {
	for _, r := range redactions {
		text = r.re.ReplaceAllStringFunc(text, func(m string) string {
			if tok, ok := v.byValue[m]; ok {
				return tok
			}
			v.counts[r.kind]++
			tok := fmt.Sprintf("[%s_%d]", r.kind, v.counts[r.kind])
			v.byToken[tok], v.byValue[m] = m, tok
			return tok
		})
	}
	return text
}

var placeholder = regexp.MustCompile(`\[(?:EMAIL|CARD|PHONE|NEMTAG|NUMBER)_\d+\]`)

// Restore turns placeholders back into the customer's own values; a placeholder the vault
// never issued (the model made one up) is dropped.
func (v *Vault) Restore(text string) string {
	return placeholder.ReplaceAllStringFunc(text, func(tok string) string { return v.byToken[tok] })
}

// ---- prompt injection -------------------------------------------------------------------

// injection catches the common ways of telling a model to drop its rules. It is one layer
// among several (the model has no tool that can do harm, tool output is cleaned, and the
// reply is sanitised), so it can afford to be narrow: a miss costs nothing the other layers
// do not catch, and a false hit only sends the customer to the shortcuts.
var injection = regexp.MustCompile(`(?i)` + strings.Join([]string{
	`(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|your|the)\b.{0,30}\b(instruction|prompt|rule|guideline)s?`,
	`(reveal|show|print|repeat|output|tell me)\b.{0,30}\b(system|hidden|initial|original)\b.{0,15}\b(prompt|instruction|message)s?`,
	`\byou are now\b`,
	`\b(developer|debug|dan|jailbreak|god) mode\b`,
	`\bpretend (that )?(you have|there are) no (rule|restriction|limit)`,
	`<\|?(im_start|im_end|system|endoftext)\|?>`,
	`(^|\n)\s*(#{2,}\s*)?(system|assistant)\s*:`,
}, "|"))

// LooksLikeInjection reports whether the text tries to override the assistant's rules.
func LooksLikeInjection(text string) bool { return injection.MatchString(text) }

// ---- cleaning what flows in and out -----------------------------------------------------

// CleanLabel makes text from the outside world (a merchant name from a card statement) safe
// to put in front of a model: letters, digits and a little punctuation, short, one line.
// Narrations and notes are never passed at all; names are the least that tools need.
func CleanLabel(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '&' || r == '.' || r == '-':
			b.WriteRune(r)
		}
		if b.Len() >= 40 {
			break
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

var (
	markdownImage = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	markdownLink  = regexp.MustCompile(`\[([^\]]+)\]\((?:[^)]*)\)`)
	bareURL       = regexp.MustCompile(`(?i)\b(?:https?://|www\.)\S+`)
	htmlTag       = regexp.MustCompile(`</?[A-Za-z][^>]*>`)
)

// StreamFilter cleans the live preview of an answer. Text arrives in arbitrary pieces, so it
// is released a whole word at a time; a word that carries a link, a tag or the middle of a
// markdown link never goes out, and a placeholder is turned back into the customer's value.
type StreamFilter struct {
	vault *Vault
	hold  string
}

// NewStreamFilter returns a filter that restores placeholders from vault.
func NewStreamFilter(v *Vault) *StreamFilter { return &StreamFilter{vault: v} }

var wordOrSpace = regexp.MustCompile(`\S+|\s+`)

func unsafeWord(w string) bool {
	l := strings.ToLower(w)
	return strings.Contains(l, "http") || strings.Contains(l, "www.") || strings.Contains(w, "](") ||
		strings.ContainsAny(w, "<>") || strings.HasPrefix(w, "![")
}

// Write takes the next piece and returns what is safe to show so far.
func (f *StreamFilter) Write(piece string) string {
	f.hold += piece
	cut := strings.LastIndexFunc(f.hold, unicode.IsSpace)
	if cut < 0 {
		return ""
	}
	ready := f.hold[:cut+1]
	f.hold = f.hold[cut+1:]
	return f.clean(ready)
}

// Flush releases the last word once the answer is complete.
func (f *StreamFilter) Flush() string {
	ready := f.hold
	f.hold = ""
	return f.clean(ready)
}

func (f *StreamFilter) clean(s string) string {
	var b strings.Builder
	for _, tok := range wordOrSpace.FindAllString(s, -1) {
		if strings.TrimSpace(tok) != "" && unsafeWord(tok) {
			continue
		}
		b.WriteString(f.vault.Restore(tok))
	}
	return b.String()
}

// maxReplyChars keeps an answer chat-sized.
const maxReplyChars = 1500

// SanitizeReply strips what a manipulated model could use to leak or mislead: images and
// links (a URL can carry the customer's data out), HTML, and anything past a chat-sized
// answer. Plain text and simple lists survive.
func SanitizeReply(s string) string {
	s = markdownImage.ReplaceAllString(s, "")
	s = markdownLink.ReplaceAllString(s, "$1")
	s = bareURL.ReplaceAllString(s, "[link removed]")
	s = htmlTag.ReplaceAllString(s, "")
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > maxReplyChars {
		s = strings.TrimSpace(string(r[:maxReplyChars])) + "…"
	}
	return s
}
