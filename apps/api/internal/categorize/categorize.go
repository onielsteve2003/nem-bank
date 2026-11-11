// Package categorize files a payment under a spending category (AI-3). Two steps run here,
// both pure functions of the text: a merchant dictionary, then a TF-IDF + logistic regression
// model trained in Python (ml/) and scored with plain Go arithmetic, so there is no Python
// service in production. The customer's own rules and corrections, which beat both, live with
// the transactions in the accounts package.
//
// The dictionary alone is the non-AI fallback: Classifier without a model still works.
package categorize

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/textmodel"
)

//go:embed model/model.json model/merchants.json
var modelFS embed.FS

// Source says who chose the category (contract CategorySource).
type Source string

// The sources the classifier can produce. SourceUser is set by the accounts package.
const (
	SourceRules Source = "rules"
	SourceModel Source = "model"
	SourceUser  Source = "user"
)

// Result is the classifier's answer for one piece of text.
type Result struct {
	Category string
	Source   Source
	// Confidence is the model's probability, 0 to 1; zero for dictionary answers.
	Confidence float64
	// Reason is a short plain-language "why", for the AI badge.
	Reason       string
	ModelVersion string
}

type entry struct {
	words    []string
	category string
}

// Classifier is safe for concurrent use.
type Classifier struct {
	dict  []entry
	model *textmodel.Model // nil: dictionary only
}

// New loads the dictionary and the model. A model that will not load is an error; use
// DictionaryOnly to run without one on purpose.
func New() (*Classifier, error) {
	c, err := DictionaryOnly()
	if err != nil {
		return nil, err
	}
	raw, err := modelFS.ReadFile("model/model.json")
	if err != nil {
		return nil, fmt.Errorf("categorize: read model: %w", err)
	}
	m, err := textmodel.Load(raw)
	if err != nil {
		return nil, fmt.Errorf("categorize: %w", err)
	}
	for _, class := range m.Classes {
		if !ValidCategory(class) {
			return nil, fmt.Errorf("categorize: model class %q is not a category", class)
		}
	}
	if m.Threshold <= 0 || m.Threshold >= 1 {
		return nil, errors.New("categorize: model threshold is not between 0 and 1")
	}
	c.model = m
	return c, nil
}

// DictionaryOnly is the non-AI classifier: the merchant dictionary and nothing else.
func DictionaryOnly() (*Classifier, error) {
	raw, err := modelFS.ReadFile("model/merchants.json")
	if err != nil {
		return nil, fmt.Errorf("categorize: read dictionary: %w", err)
	}
	var rows []struct{ Keyword, Category string }
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("categorize: parse dictionary: %w", err)
	}
	c := &Classifier{}
	for _, r := range rows { // already longest keyword first
		w := strings.Fields(r.Keyword)
		if len(w) == 0 || !ValidCategory(r.Category) {
			return nil, fmt.Errorf("categorize: bad dictionary entry %q -> %q", r.Keyword, r.Category)
		}
		c.dict = append(c.dict, entry{words: w, category: r.Category})
	}
	return c, nil
}

// ModelLoaded reports whether the model is in use.
func (c *Classifier) ModelLoaded() bool { return c.model != nil }

// Classify returns the dictionary's answer if there is one, else the model's if it is
// confident. ok is false when neither has an opinion, and the caller keeps its own category.
func (c *Classifier) Classify(text string) (Result, bool) {
	words := textmodel.Words(text)
	if cat, kw, ok := c.lookup(words); ok {
		return Result{Category: cat, Source: SourceRules, Reason: "Matches the merchant “" + kw + "”."}, true
	}
	if c.model == nil || len(words) == 0 {
		return Result{}, false
	}
	probs := c.model.ProbabilitiesOf(words)
	best := 0
	for i, p := range probs {
		if p > probs[best] {
			best = i
		}
	}
	if probs[best] < c.model.Threshold {
		return Result{}, false
	}
	return Result{
		Category: c.model.Classes[best], Source: SourceModel, Confidence: probs[best], ModelVersion: c.model.Name,
		Reason: "The name looks like others filed under this category.",
	}, true
}

func (c *Classifier) lookup(words []string) (category, keyword string, ok bool) {
	for _, e := range c.dict {
		n := len(e.words)
		for i := 0; i+n <= len(words); i++ {
			match := true
			for j := 0; j < n; j++ {
				if words[i+j] != e.words[j] {
					match = false
					break
				}
			}
			if match {
				return e.category, strings.Join(e.words, " "), true
			}
		}
	}
	return "", "", false
}

// MerchantKey is how a merchant is keyed for a customer's rules: case and spacing never split
// one merchant in two. It matches the mobile app's merchantKey.
func MerchantKey(name string) string {
	return strings.ToLower(strings.Join(strings.Fields(name), " "))
}

var categories = map[string]bool{
	"food": true, "groceries": true, "transport": true, "airtime_data": true, "bills_utilities": true,
	"shopping": true, "entertainment": true, "subscriptions": true, "health": true, "education": true,
	"rent_housing": true, "family": true, "transfers": true, "salary_income": true, "savings": true,
	"fees_charges": true, "cash": true, "other": true,
}

// ValidCategory reports whether c is a contract Category.
func ValidCategory(c string) bool { return categories[c] }
