package audit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// canonicalJSON rewrites a JSON document in canonical form.
func canonicalJSON(raw []byte) (json.RawMessage, error) {
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("audit: canonical json: %w", err)
	}
	var b strings.Builder
	if err := writeCanonical(&b, v); err != nil {
		return nil, err
	}
	return json.RawMessage(b.String()), nil
}

// writeCanonical writes v as the console's canonical() does: object keys sorted, no
// whitespace, strings and numbers exactly as JSON.stringify writes them. v holds what
// encoding/json decodes with UseNumber, plus the strings and maps HashEntry builds.
//
// Keys are compared byte-wise (UTF-8) where JavaScript compares UTF-16 code units; the two
// orders differ only between characters above U+FFFF and U+E000–U+FFFF, which audit keys
// (snake_case) never contain.
func writeCanonical(b *strings.Builder, v any) error {
	switch v := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(v))
	case string:
		writeJSString(b, v)
	case json.Number:
		n, err := jsNumber(v)
		if err != nil {
			return err
		}
		b.WriteString(n)
	case []any:
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSString(b, k)
			b.WriteByte(':')
			if err := writeCanonical(b, v[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("audit: cannot canonicalise %T", v)
	}
	return nil
}

// writeJSString quotes s as JSON.stringify does. Unlike encoding/json it leaves <, >, &
// and U+2028/U+2029 as they are, and writes other control characters as lowercase \u00xx.
func writeJSString(b *strings.Builder, s string) {
	const hex = "0123456789abcdef"
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hex[r>>4])
				b.WriteByte(hex[r&0xF])
				continue
			}
			if r == utf8.RuneError {
				r = '�' // invalid UTF-8 reads as U+FFFD, as it does once decoded in JS
			}
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// jsNumber formats a JSON number as JavaScript's Number#toString: integers in plain
// digits below 1e21, exponents as "1e+21" and "1.5e-7", and -0 as 0.
func jsNumber(n json.Number) (string, error) {
	if i, err := strconv.ParseInt(string(n), 10, 64); err == nil && math.Abs(float64(i)) < 1<<53 {
		return strconv.FormatInt(i, 10), nil
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return "", fmt.Errorf("audit: number %q is not finite", string(n))
	}
	if f == 0 {
		return "0", nil
	}
	abs := math.Abs(f)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64) // "1.5e-07"
		mant, exp, _ := strings.Cut(s, "e")
		sign, digits := exp[:1], strings.TrimLeft(exp[1:], "0")
		return mant + "e" + sign + digits, nil
	}
	return strconv.FormatFloat(f, 'f', -1, 64), nil
}
