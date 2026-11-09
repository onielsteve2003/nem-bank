package cop

import (
	"math"
	"testing"
)

func TestJaroWinklerKnownValues(t *testing.T) {
	t.Parallel()
	// The classic pairs from Winkler (1990), to three decimals.
	tests := []struct {
		a, b string
		want float64
	}{
		{"martha", "marhta", 0.961},
		{"dwayne", "duane", 0.840},
		{"dixon", "dicksonx", 0.813},
		{"same", "same", 1},
		{"abc", "xyz", 0},
		{"", "", 1},
		{"a", "", 0},
	}
	for _, tt := range tests {
		got := JaroWinkler(tt.a, tt.b)
		if math.Abs(got-tt.want) > 0.0005 {
			t.Errorf("JaroWinkler(%q, %q) = %.4f, want %.3f", tt.a, tt.b, got, tt.want)
		}
		if back := JaroWinkler(tt.b, tt.a); math.Abs(back-got) > 1e-9 {
			t.Errorf("JaroWinkler is not symmetric for %q, %q: %.4f vs %.4f", tt.a, tt.b, got, back)
		}
	}
}

func TestCompare(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, expected, actual string
		want                   Result
	}{
		{"identical", "Chinedu Okafor", "Chinedu Okafor", Match},
		{"case, punctuation and order do not matter", "okafor, CHINEDU.", "Chinedu Okafor", Match},
		{"titles are ignored", "Chief Mrs Folake Eze", "Folake Eze", Match},
		{"a short form of the first name is close", "Tolu Adebayo", "Tolulope Adebayo", CloseMatch},
		{"one typo is close, not a match", "Chinedu Okafro", "Chinedu Okafor", CloseMatch},
		{"a missing middle name is close", "Adaeze Okafor", "Adaeze Ngozi Okafor", CloseMatch},
		{"the surname alone is close", "Okafor", "Adaeze Okafor", CloseMatch},
		{"a different person is no match", "John Smith", "Adaeze Okafor", NoMatch},
		{"the right first name on someone else's account is no match", "Chinedu Bello", "Chinedu Okafor", NoMatch},
		{"nothing typed is no match", "  ", "Adaeze Okafor", NoMatch},
		{"only a title is no match", "Mr", "Adaeze Okafor", NoMatch},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := Compare(tt.expected, tt.actual)
			if got.Result != tt.want {
				t.Fatalf("Compare(%q, %q) = %s (%.2f), want %s", tt.expected, tt.actual, got.Result, got.Confidence, tt.want)
			}
			if got.Confidence < 0 || got.Confidence > 1 {
				t.Fatalf("confidence %.2f is outside 0..1", got.Confidence)
			}
		})
	}
}

func FuzzCompare(f *testing.F) {
	f.Add("Tolu Adebayo", "Tolulope Adebayo")
	f.Add("", "x")
	f.Add("Ọlá Adéṣínà", "Ola Adesina")
	f.Fuzz(func(t *testing.T, a, b string) {
		o := Compare(a, b)
		if o.Confidence < 0 || o.Confidence > 1 || math.IsNaN(o.Confidence) {
			t.Fatalf("Compare(%q, %q) confidence %v", a, b, o.Confidence)
		}
		if a == b && len(words(a)) > 0 && o.Result != Match {
			t.Fatalf("Compare(%q, itself) = %s", a, o.Result)
		}
	})
}
