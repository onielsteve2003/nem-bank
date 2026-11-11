// Package scam answers "is this message, link or account a scam?" (SEC-6, AI-2). A message is
// judged three ways: the Nigerian scam rules, link checks (look-alike domains, short links,
// bare IP addresses), and a text model trained on the UCI SMS Spam Collection plus generated
// Nigerian scams (ml/). The strongest verdict wins and every reason is shown to the customer.
//
// The content is checked and discarded: it is never stored, never logged and never sent to an
// LLM. The rules alone work with no model (the non-AI fallback), and the same rules run on the
// phone with no network (packages/shared/src/scam.ts).
package scam

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/textmodel"
)

//go:embed model/model.json model/scam_rules.json
var modelFS embed.FS

// Verdict is the contract's ScamCheckResult verdict.
type Verdict string

// The verdicts, mildest first.
const (
	LooksSafe  Verdict = "looks_safe"
	Suspicious Verdict = "suspicious"
	LikelyScam Verdict = "likely_scam"
)

// Reason is one explained part of a verdict (contract RiskReason).
type Reason struct {
	Code     string
	Severity string // low, medium or high
	Message  string
}

// Result is a verdict with its reasons.
type Result struct {
	Verdict Verdict
	// Score is 0 (no signs) to 1 (many strong signs), two decimals.
	Score        float64
	Reasons      []Reason
	Advice       string
	ModelVersion string
	// ModelUsed is false when the rules alone judged the message (the fallback).
	ModelUsed bool
}

// Advice per verdict, in the app's words.
var advice = map[Verdict]string{
	LikelyScam: "Do not reply, click or send money. Block the sender and report it from Support.",
	Suspicious: "Be careful. Contact the person or company through a number you already trust.",
	LooksSafe:  "We found no warning signs, but never share your PIN or OTP with anyone.",
}

type rule struct {
	Reason
	pattern *regexp.Regexp
	unless  *regexp.Regexp
}

type rulesFile struct {
	Weights      map[string]float64 `json:"weights"`
	Base         float64            `json:"base"`
	LikelyScamAt float64            `json:"likely_scam_at"`
	SuspiciousAt float64            `json:"suspicious_at"`
	Rules        []struct {
		Code, Severity, Message, Pattern, Unless string
	} `json:"rules"`
}

// Checker is safe for concurrent use.
type Checker struct {
	rules        []rule
	weights      map[string]float64
	base         float64
	likelyAt     float64
	suspiciousAt float64
	own          []string // hosts that really are Nem's
	model        *textmodel.Model
	tLow, tHigh  float64
}

// DefaultOwnDomains are the hosts that count as Nem's own; any other host that looks like a
// bank is a look-alike.
var DefaultOwnDomains = []string{"nem-bank-fodx.vercel.app"}

// New loads the rules and the model. A model that will not load is an error; use RulesOnly to
// run without one on purpose.
func New(ownDomains ...string) (*Checker, error) {
	c, err := RulesOnly(ownDomains...)
	if err != nil {
		return nil, err
	}
	raw, err := modelFS.ReadFile("model/model.json")
	if err != nil {
		return nil, fmt.Errorf("scam: read model: %w", err)
	}
	m, err := textmodel.Load(raw)
	if err != nil {
		return nil, fmt.Errorf("scam: %w", err)
	}
	if len(m.Classes) != 2 || m.Classes[1] != "spam" {
		return nil, errors.New("scam: model classes are not [ham, spam]")
	}
	low, high := m.Thresholds["suspicious"], m.Thresholds["likely_scam"]
	if low <= 0 || low > high || high >= 1 {
		return nil, errors.New("scam: model thresholds are not 0 < suspicious <= likely_scam < 1")
	}
	c.model, c.tLow, c.tHigh = m, low, high
	return c, nil
}

// RulesOnly is the non-AI checker: the Nigerian scam rules and link checks, with no model.
func RulesOnly(ownDomains ...string) (*Checker, error) {
	raw, err := modelFS.ReadFile("model/scam_rules.json")
	if err != nil {
		return nil, fmt.Errorf("scam: read rules: %w", err)
	}
	var f rulesFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("scam: parse rules: %w", err)
	}
	if len(ownDomains) == 0 {
		ownDomains = DefaultOwnDomains
	}
	c := &Checker{weights: f.Weights, base: f.Base, likelyAt: f.LikelyScamAt, suspiciousAt: f.SuspiciousAt, own: ownDomains}
	for _, w := range []string{"low", "medium", "high"} {
		if _, ok := f.Weights[w]; !ok {
			return nil, fmt.Errorf("scam: no weight for %s severity", w)
		}
	}
	for _, r := range f.Rules {
		if _, ok := f.Weights[r.Severity]; !ok {
			return nil, fmt.Errorf("scam: rule %s has unknown severity %q", r.Code, r.Severity)
		}
		p, err := regexp.Compile("(?i)" + r.Pattern)
		if err != nil {
			return nil, fmt.Errorf("scam: rule %s: %w", r.Code, err)
		}
		cr := rule{Reason: Reason{Code: r.Code, Severity: r.Severity, Message: r.Message}, pattern: p}
		if r.Unless != "" {
			if cr.unless, err = regexp.Compile("(?i)" + r.Unless); err != nil {
				return nil, fmt.Errorf("scam: rule %s unless: %w", r.Code, err)
			}
		}
		c.rules = append(c.rules, cr)
	}
	return c, nil
}

// ModelLoaded reports whether the text model is in use.
func (c *Checker) ModelLoaded() bool { return c.model != nil }

// MessageRules returns the codes of the message rules that fire on text.
func (c *Checker) MessageRules(text string) []string {
	var codes []string
	for _, r := range c.messageReasons(strings.TrimSpace(text)) {
		codes = append(codes, r.Code)
	}
	return codes
}

func (c *Checker) messageReasons(t string) []Reason {
	var out []Reason
	for _, r := range c.rules {
		if r.pattern.MatchString(t) && (r.unless == nil || !r.unless.MatchString(t)) {
			out = append(out, r.Reason)
		}
	}
	return out
}

// CheckMessage judges a message someone sent the customer: rules, links and the text model.
func (c *Checker) CheckMessage(text string) Result {
	t := strings.TrimSpace(text)
	reasons := append(c.messageReasons(t), c.linkReasons(t)...)
	ruleScore := c.score(reasons)
	res := Result{ModelVersion: ""}
	score, verdict := ruleScore, c.verdict(ruleScore)

	if c.model != nil && len(textmodel.Words(t)) > 0 {
		spam := c.model.Probabilities(t)[1]
		res.ModelUsed, res.ModelVersion = true, c.model.Name
		var modelVerdict Verdict
		switch {
		case spam >= c.tHigh:
			modelVerdict = LikelyScam
			reasons = append(reasons, Reason{Code: "wording_matches_scams", Severity: "high",
				Message: "The wording is very close to messages reported as scams or spam."})
		case spam >= c.tLow:
			modelVerdict = Suspicious
			reasons = append(reasons, Reason{Code: "wording_resembles_scams", Severity: "medium",
				Message: "The wording looks like messages reported as scams or spam."})
		}
		if rank(modelVerdict) > rank(verdict) {
			verdict = modelVerdict
		}
		score = math.Max(score, spam)
	}
	res.Verdict, res.Score = verdict, round2(math.Min(score, 1))
	res.Reasons, res.Advice = uniqueReasons(reasons), advice[verdict]
	return res
}

// CheckLink judges a link on its own: the link checks and the rules, without the text model
// (a bare address is not what the model was trained to read).
func (c *Checker) CheckLink(text string) Result {
	t := strings.TrimSpace(text)
	reasons := uniqueReasons(append(c.messageReasons(t), c.linkReasons(t)...))
	v := c.verdict(c.score(reasons))
	return Result{Verdict: v, Score: round2(c.score(reasons)), Reasons: reasons, Advice: advice[v]}
}

// CheckAccount judges an account number from what is known about it: whether it is a Nem
// account and whether other customers reported it.
func (c *Checker) CheckAccount(known, reported bool) Result {
	var reasons []Reason
	if reported {
		reasons = append(reasons, Reason{Code: "reported_account", Severity: "high", Message: "Other customers reported this account for scams."})
	}
	if !known {
		reasons = append(reasons, Reason{Code: "unknown_account", Severity: "medium", Message: "We could not confirm who owns this account."})
	}
	v := c.verdict(c.score(reasons))
	return Result{Verdict: v, Score: round2(c.score(reasons)), Reasons: reasons, Advice: advice[v]}
}

// score is a base plus a weight per reason, as the app's scamResult.
func (c *Checker) score(reasons []Reason) float64 {
	s := c.base
	for _, r := range reasons {
		s += c.weights[r.Severity]
	}
	return math.Min(1, s)
}

func (c *Checker) verdict(score float64) Verdict {
	switch {
	case score >= c.likelyAt:
		return LikelyScam
	case score >= c.suspiciousAt:
		return Suspicious
	default:
		return LooksSafe
	}
}

func rank(v Verdict) int {
	switch v {
	case LikelyScam:
		return 2
	case Suspicious:
		return 1
	default:
		return 0
	}
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// uniqueReasons says each reason once, however often it was found.
func uniqueReasons(in []Reason) []Reason {
	out := make([]Reason, 0, len(in))
	seen := map[string]bool{}
	for _, r := range in {
		if !seen[r.Code] {
			seen[r.Code] = true
			out = append(out, r)
		}
	}
	return out
}

var (
	linkRE     = regexp.MustCompile(`(?i)\b(?:https?://)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:/\S*)?|\bhttps?://\d{1,3}(?:\.\d{1,3}){3}\S*`)
	ipHostRE   = regexp.MustCompile(`^\d{1,3}(\.\d{1,3}){3}$`)
	shortener  = regexp.MustCompile(`(?i)^(bit\.ly|tinyurl\.com|t\.co|cutt\.ly|is\.gd|rb\.gy|shorturl\.at|tiny\.cc)$`)
	brandWords = regexp.MustCompile(`nem|bank|cbn|bvn|nin|verify|secure|login`)
)

// linkReasons checks every link in text for the usual tricks.
func (c *Checker) linkReasons(text string) []Reason {
	var out []Reason
	for _, raw := range linkRE.FindAllString(text, -1) {
		link := strings.ToLower(raw)
		host := strings.TrimPrefix(strings.TrimPrefix(link, "https://"), "http://")
		if i := strings.IndexAny(host, "/?#"); i >= 0 {
			host = host[:i]
		}
		if c.isOurs(host) {
			continue
		}
		switch {
		case ipHostRE.MatchString(host):
			out = append(out, Reason{Code: "ip_link", Severity: "high", Message: "The link is a bare number address, which real companies do not use."})
		case hasPunycode(host):
			out = append(out, Reason{Code: "disguised_link", Severity: "high", Message: host + " uses look-alike letters to copy a real website."})
		case shortener.MatchString(host):
			out = append(out, Reason{Code: "short_link", Severity: "medium", Message: "Short links hide where they really go."})
		case brandWords.MatchString(host):
			out = append(out, Reason{Code: "lookalike_domain", Severity: "high", Message: host + " is not a Nem website."})
		}
		if strings.HasPrefix(link, "http://") {
			out = append(out, Reason{Code: "insecure_link", Severity: "medium", Message: "The link is not secure (http)."})
		}
	}
	return out
}

func hasPunycode(host string) bool {
	for _, part := range strings.Split(host, ".") {
		if strings.HasPrefix(part, "xn--") {
			return true
		}
	}
	return false
}

func (c *Checker) isOurs(host string) bool {
	for _, d := range c.own {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}
