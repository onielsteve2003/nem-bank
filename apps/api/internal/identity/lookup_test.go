package identity

import "testing"

func TestPhoneHandleAcceptsTheUsualSpellings(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"08031234567": "+2348031234567", "+2348031234567": "+2348031234567", "2348031234567": "+2348031234567",
		"0803 123 4567": "+2348031234567", "(0803)-123-4567": "+2348031234567",
	} {
		if got, ok := phoneHandle(in); !ok || got != want {
			t.Errorf("phoneHandle(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{"ada", "@ada", "0803123456", "080312345678", "0803123456x", "+1 415 555 0100"} {
		if got, ok := phoneHandle(in); ok {
			t.Errorf("phoneHandle(%q) = %q, want not a phone", in, got)
		}
	}
}
