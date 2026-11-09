package identity

import (
	"testing"
	"time"
)

func TestANewDeviceIsCappedForADayAndTheSignUpDeviceIsNot(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	first := h.signedUp(t, "tolu@example.com", "+2348031234567")

	c, err := h.svc.CoolOff(h.authed(t, first))
	if err != nil {
		t.Fatal(err)
	}
	if c.Active || c.Until != nil || c.DailyLimitMinor != 0 {
		t.Fatalf("sign-up device cool-off = %+v", c)
	}

	ipad := phone(2)
	second, err := h.svc.Login(t.Context(), LoginInput{Identifier: "tolu@example.com", Password: strongPassword, Device: &ipad})
	if err != nil {
		t.Fatal(err)
	}
	ctx := h.authed(t, second)
	c, err = h.svc.CoolOff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Active || c.Reason != "new_device" || c.DailyLimitMinor != 50_000_00 ||
		c.Until == nil || !c.Until.Equal(h.clock.Now().Add(24*time.Hour)) {
		t.Fatalf("new device cool-off = %+v", c)
	}

	// Access tokens last 10 minutes; a refresh gives a session to ask with a day later.
	h.clock.Advance(24 * time.Hour)
	later, err := h.svc.Refresh(t.Context(), second.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	c, err = h.svc.CoolOff(h.authed(t, later))
	if err != nil {
		t.Fatal(err)
	}
	if c.Active || c.DailyLimitMinor != 0 || c.Until == nil {
		t.Fatalf("after 24 h = %+v", c)
	}
}
