// Package textmodel scores short text with a TF-IDF + logistic regression model exported from
// Python (ml/): scikit-learn's character n-grams inside words, sublinear tf, idf, L2 norm,
// then a softmax over the class weights. It is plain arithmetic, so there is no Python in
// production. Smart categories and the scam checker both use it; each brings its own model file.
//
// The Python side (ml/src/nemml/categories.py `score_text`) is the reference. Golden tests in
// each caller keep the two equal.
package textmodel

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
)

// Model is a loaded model. It is safe for concurrent use.
type Model struct {
	Name    string
	Classes []string
	// Thresholds are named confidence cut-offs the model's owner chose on validation data.
	Thresholds map[string]float64
	// Threshold is the single cut-off of a model that has only one (smart categories).
	Threshold float64

	ngramLo, ngramHi int
	index            map[string]int
	idf              []float64
	coef             [][]float64 // term-major: coef[term][class]
	intercept        []float64
}

type file struct {
	Model      string             `json:"model"`
	Classes    []string           `json:"classes"`
	NGram      []int              `json:"ngram"`
	Terms      []string           `json:"terms"`
	IDF        []float64          `json:"idf"`
	Coef       [][]float64        `json:"coef"`
	Intercept  []float64          `json:"intercept"`
	Threshold  float64            `json:"threshold"`
	Thresholds map[string]float64 `json:"thresholds"`
}

// Load parses an exported model file and checks it is consistent.
func Load(raw []byte) (*Model, error) {
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("textmodel: parse: %w", err)
	}
	n := len(f.Terms)
	if len(f.NGram) != 2 || f.NGram[0] < 1 || f.NGram[1] < f.NGram[0] || len(f.IDF) != n || len(f.Coef) != n ||
		len(f.Classes) == 0 || len(f.Intercept) != len(f.Classes) {
		return nil, errors.New("textmodel: model file is inconsistent")
	}
	m := &Model{
		Name: f.Model, Classes: f.Classes, Threshold: f.Threshold, Thresholds: f.Thresholds,
		ngramLo: f.NGram[0], ngramHi: f.NGram[1], idf: f.IDF, coef: f.Coef, intercept: f.Intercept,
		index: make(map[string]int, n),
	}
	for i, t := range f.Terms {
		m.index[t] = i
		if len(f.Coef[i]) != len(f.Classes) {
			return nil, fmt.Errorf("textmodel: term %d has %d weights, want %d", i, len(f.Coef[i]), len(f.Classes))
		}
	}
	return m, nil
}

// Normalize is the text the models read: ASCII lowercase letters, each run of digits as a
// single "0", everything else a space. ml/src/nemml/merchants.py does the same.
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

// Words is the normalized text split into words.
func Words(text string) []string { return strings.Fields(Normalize(text)) }

// Probabilities scores text: one probability per class, in Classes order. Text with no
// words scores the intercepts alone, as in Python.
func (m *Model) Probabilities(text string) []float64 {
	return m.ProbabilitiesOf(Words(text))
}

// ProbabilitiesOf scores already-normalized words.
func (m *Model) ProbabilitiesOf(words []string) []float64 {
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
