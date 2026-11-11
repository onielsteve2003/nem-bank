package bills

import "strings"

// networkPrefixes are the NCC number allocations (the first four digits of the local
// number), for airtime auto-detect (BILL-1).
var networkPrefixes = map[string][]string{
	MTN:        {"0803", "0806", "0703", "0706", "0813", "0816", "0810", "0814", "0903", "0906", "0913", "0916"},
	Airtel:     {"0802", "0808", "0708", "0812", "0701", "0902", "0901", "0904", "0907", "0912"},
	Glo:        {"0805", "0807", "0705", "0815", "0811", "0905", "0915"},
	NineMobile: {"0809", "0818", "0817", "0909", "0908"},
}

// NormalizePhone turns 0803..., 234803... or +234803... (spaces and dashes allowed) into
// E.164, or reports that it is not a Nigerian mobile number.
func NormalizePhone(s string) (string, bool) {
	s = strings.NewReplacer(" ", "", "-", "").Replace(s)
	s = strings.TrimPrefix(s, "+")
	switch {
	case strings.HasPrefix(s, "234"):
		s = s[3:]
	case strings.HasPrefix(s, "0"):
		s = s[1:]
	default:
		return "", false
	}
	// Ten digits after the country code, the first being the network's 7, 8 or 9.
	if len(s) != 10 || !allDigits(s) || !strings.Contains("789", s[:1]) {
		return "", false
	}
	return "+234" + s, true
}

// DetectNetwork names the network a Nigerian number is allocated to, or "" when the number
// or its prefix is unknown. A ported number may belong to another network now, so the app
// lets the customer override the answer.
func DetectNetwork(phone string) string {
	e164, ok := NormalizePhone(phone)
	if !ok {
		return ""
	}
	local := "0" + e164[4:]
	for network, prefixes := range networkPrefixes {
		for _, p := range prefixes {
			if strings.HasPrefix(local, p) {
				return network
			}
		}
	}
	return ""
}
