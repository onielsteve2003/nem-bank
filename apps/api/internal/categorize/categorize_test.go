package categorize

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

func mustNew(t testing.TB) *Classifier {
	t.Helper()
	c, err := New()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// TestScoresMatchPython is the parity gate: the Go scorer must reproduce the probabilities
// the Python exporter computed for 60 texts, including empty, digit-only and non-ASCII ones.
func TestScoresMatchPython(t *testing.T) {
	c := mustNew(t)
	raw, err := os.ReadFile("model/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Tolerance float64 `json:"tolerance"`
		Cases     []struct {
			Text          string    `json:"text"`
			Probabilities []float64 `json:"probabilities"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 60 {
		t.Fatalf("golden has %d cases, want 60", len(g.Cases))
	}
	for _, tc := range g.Cases {
		words := splitWords(tc.Text)
		var got []float64
		if len(words) == 0 {
			// No words: the model scores the intercepts alone, as Python does.
			got = c.model.probabilities(nil)
		} else {
			got = c.model.probabilities(words)
		}
		for k, want := range tc.Probabilities {
			if math.Abs(got[k]-want) > g.Tolerance*0.01 { // golden is rounded to 6 places
				t.Errorf("%q class %s: go %.6f, python %.6f", tc.Text, c.model.classes[k], got[k], want)
			}
		}
	}
}

func splitWords(text string) []string {
	var out []string
	cur := ""
	for _, r := range Normalize(text) + " " {
		if r == ' ' {
			if cur != "" {
				out = append(out, cur)
			}
			cur = ""
			continue
		}
		cur += string(r)
	}
	return out
}

func TestNormalizeMatchesPython(t *testing.T) {
	for in, want := range map[string]string{
		"POS/Shoprite-Lekki 08031234567!": "pos shoprite lekki 0 ",
		"N1,500.00 Café":                  "n0 0 0 caf ",
		"":                                "",
	} {
		if got := Normalize(in); got != want {
			t.Errorf("Normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDictionaryComesFirstAndMatchesWholeWords(t *testing.T) {
	c := mustNew(t)
	for text, want := range map[string]string{
		"POS/SHOPRITE LEKKI/LAGOS NG":  "groceries",
		"PAYSTACK*Netflix.com":         "subscriptions",
		"mtn airtime 08031234567":      "airtime_data",
		"BOLT RIDE 2291":               "transport",
		"Chicken Republic Ikeja":       "food",
		"IKEDC prepaid meter 12345678": "bills_utilities",
	} {
		r, ok := c.Classify(text)
		if !ok || r.Category != want || r.Source != SourceRules || r.Confidence != 0 || r.Reason == "" {
			t.Errorf("%q: %+v ok=%v, want %s from rules", text, r, ok, want)
		}
	}
	if r, ok := c.Classify("Sparkle Cleaners 0099"); ok && r.Source == SourceRules {
		t.Errorf("spar matched inside sparkle: %+v", r)
	}
}

func TestModelHandlesMerchantsItNeverSawWithConfidence(t *testing.T) {
	c := mustNew(t)
	for text, want := range map[string]string{
		"POS/Adaobi Chemist LEKKI": "health",
		"Halima Supermarket Wuse":  "groceries",
		"Emeka Cab Services":       "transport",
		"Zenith Academy Fees":      "education",
	} {
		r, ok := c.Classify(text)
		if !ok || r.Source != SourceModel || r.Category != want {
			t.Errorf("%q: %+v ok=%v, want %s from the model", text, r, ok, want)
			continue
		}
		if r.Confidence <= 0 || r.Confidence > 1 || r.ModelVersion == "" {
			t.Errorf("%q: confidence %v, version %q", text, r.Confidence, r.ModelVersion)
		}
	}
}

func TestNoOpinionWhenNothingIsKnown(t *testing.T) {
	c := mustNew(t)
	for _, text := range []string{"", "   ", "12345 67890", "!!!"} {
		if r, ok := c.Classify(text); ok {
			t.Errorf("%q gave an answer: %+v", text, r)
		}
	}
}

func TestDictionaryOnlyIsTheFallback(t *testing.T) {
	c, err := DictionaryOnly()
	if err != nil {
		t.Fatal(err)
	}
	if c.ModelLoaded() {
		t.Fatal("dictionary-only classifier has a model")
	}
	if r, ok := c.Classify("Shoprite"); !ok || r.Category != "groceries" {
		t.Fatalf("dictionary: %+v %v", r, ok)
	}
	if _, ok := c.Classify("Adaobi Chemist"); ok {
		t.Fatal("dictionary-only guessed a merchant it does not know")
	}
}

func TestMerchantKey(t *testing.T) {
	if MerchantKey("  Chicken   Republic ") != "chicken republic" || MerchantKey("BOLT") != MerchantKey("bolt") {
		t.Fatal("merchant keys must ignore case and spacing")
	}
}

func BenchmarkClassify(b *testing.B) {
	c := mustNew(b)
	b.ResetTimer()
	for range b.N {
		c.Classify("POS/Adaobi Chemist LEKKI/LAGOS NG")
	}
}
