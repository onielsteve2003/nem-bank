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
	"math"
	"strings"
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

type textModel struct {
	name      string
	classes   []string
	ngramLo   int
	ngramHi   int
	index     map[string]int
	idf       []float64
	coef      [][]float64 // term-major: coef[term][class]
	intercept []float64
	threshold float64
}

// Classifier is safe for concurrent use.
type Classifier struct {
	dict  []entry
	model *textModel // nil: dictionary only
}

type modelFile struct {
	Model     string      `json:"model"`
	Classes   []string    `json:"classes"`
	NGram     []int       `json:"ngram"`
	Terms     []string    `json:"terms"`
	IDF       []float64   `json:"idf"`
	Coef      [][]float64 `json:"coef"`
	Intercept []float64   `json:"intercept"`
	Threshold float64     `json:"threshold"`
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
	var f modelFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("categorize: parse model: %w", err)
	}
	m, err := buildModel(f)
	if err != nil {
		return nil, err
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

func buildModel(f modelFile) (*textModel, error) {
	n := len(f.Terms)
	if len(f.NGram) != 2 || len(f.IDF) != n || len(f.Coef) != n || len(f.Intercept) != len(f.Classes) || len(f.Classes) == 0 {
		return nil, errors.New("categorize: model file is inconsistent")
	}
	for _, c := range f.Classes {
		if !ValidCategory(c) {
			return nil, fmt.Errorf("categorize: model class %q is not a category", c)
		}
	}
	m := &textModel{
		name: f.Model, classes: f.Classes, ngramLo: f.NGram[0], ngramHi: f.NGram[1], idf: f.IDF, coef: f.Coef,
		intercept: f.Intercept, threshold: f.Threshold, index: make(map[string]int, n),
	}
	for i, t := range f.Terms {
		m.index[t] = i
		if len(f.Coef[i]) != len(f.Classes) {
			return nil, fmt.Errorf("categorize: term %d has %d weights, want %d", i, len(f.Coef[i]), len(f.Classes))
		}
	}
	if m.threshold <= 0 || m.threshold >= 1 {
		return nil, errors.New("categorize: model threshold is not between 0 and 1")
	}
	return m, nil
}

// ModelLoaded reports whether the model is in use.
func (c *Classifier) ModelLoaded() bool { return c.model != nil }

// Normalize is the text the dictionary and the model read: ASCII lowercase letters, each run
// of digits as a single "0", everything else a space. ml/src/nemml/merchants.py does the
// same; the golden test keeps them equal.
func Normalize(text string) string {
	var b strings.Builder
	prev := ' '
	for _, r := range strings.ToLower(text) {
		c := ' '
		switch {
		case r >= 'a' && r <= 'z':
			c = r
		case r >= '0' && r <= '9':
			c = '0'
		}
		if c == '0' && prev == '0' {
			continue
		}
		b.WriteRune(c)
		prev = c
	}
	return b.String()
}

// Classify returns the dictionary's answer if there is one, else the model's if it is
// confident. ok is false when neither has an opinion, and the caller keeps its own category.
func (c *Classifier) Classify(text string) (Result, bool) {
	words := strings.Fields(Normalize(text))
	if cat, kw, ok := c.lookup(words); ok {
		return Result{Category: cat, Source: SourceRules, Reason: "Matches the merchant “" + kw + "”."}, true
	}
	if c.model == nil || len(words) == 0 {
		return Result{}, false
	}
	probs := c.model.probabilities(words)
	best := 0
	for i, p := range probs {
		if p > probs[best] {
			best = i
		}
	}
	if probs[best] < c.model.threshold {
		return Result{}, false
	}
	return Result{
		Category: c.model.classes[best], Source: SourceModel, Confidence: probs[best], ModelVersion: c.model.name,
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

// probabilities scores the already-normalized words: sklearn's char_wb n-grams, sublinear tf,
// idf, L2 norm, then softmax over the class weights.
func (m *textModel) probabilities(words []string) []float64 {
	tf := map[int]int{}
	add := func(g string) {
		if i, ok := m.index[g]; ok {
			tf[i]++
		}
	}
	for _, word := range words {
		w := []rune(" " + word + " ")
		for n := m.ngramLo; n <= m.ngramHi; n++ {
			offset := 0
			add(string(w[:min(n, len(w))]))
			for offset+n < len(w) {
				offset++
				add(string(w[offset:min(offset+n, len(w))]))
			}
			if offset == 0 {
				break
			}
		}
	}
	vals := make(map[int]float64, len(tf))
	norm := 0.0
	for i, count := range tf {
		v := (1 + math.Log(float64(count))) * m.idf[i]
		vals[i] = v
		norm += v * v
	}
	z := append([]float64(nil), m.intercept...)
	if norm > 0 {
		norm = math.Sqrt(norm)
		for i, v := range vals {
			for k := range z {
				z[k] += v / norm * m.coef[i][k]
			}
		}
	}
	top := z[0]
	for _, v := range z {
		top = math.Max(top, v)
	}
	sum := 0.0
	for k := range z {
		z[k] = math.Exp(z[k] - top)
		sum += z[k]
	}
	for k := range z {
		z[k] /= sum
	}
	return z
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
