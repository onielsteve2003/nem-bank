package identity

import (
	"strings"
	"testing"
)

func TestPasswordResetEndsSessionsAndStartsCoolOff(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx := t.Context()
	res := h.signedUp(t, "reset@example.com", "+2348031230201")
	sent := len(h.inbox.sent)

	// An unknown address gets a challenge that looks the same, and no email.
	c, err := h.svc.ForgotPassword(ctx, "nobody@example.com")
	if err != nil || c.Destination != "nobody@example.com" || len(h.inbox.sent) != sent {
		t.Fatalf("unknown email: %+v, %v, mail sent = %d", c, err, len(h.inbox.sent)-sent)
	}
	if err := h.svc.ResetPassword(ctx, c.ID, "123456", "Another-Strong-Pass-9"); err == nil {
		t.Fatal("a reset on an unknown address must fail")
	}

	c, err = h.svc.ForgotPassword(ctx, " Reset@Example.com ")
	if err != nil || len(h.inbox.sent) != sent+1 {
		t.Fatalf("known email: %v, mail sent = %d", err, len(h.inbox.sent)-sent)
	}
	code := h.inbox.lastCode(t)

	// A sign-up code cannot reset a password; a wrong code costs an attempt; a weak password
	// is refused before the code is spent.
	if err := h.svc.ResetPassword(ctx, c.ID, wrongCode(code), "Another-Strong-Pass-9"); err == nil {
		t.Fatal("a wrong code must fail")
	}
	if err := h.svc.ResetPassword(ctx, c.ID, code, "password"); err == nil {
		t.Fatal("a weak password must fail")
	}
	if err := h.svc.ResetPassword(ctx, c.ID, code, "Another-Strong-Pass-9"); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if err := h.svc.ResetPassword(ctx, c.ID, code, "Third-Strong-Pass-1-x"); err == nil {
		t.Fatal("a code works once")
	}

	// The old session is gone, the old password fails, the new one works, and every device is cooling off.
	if _, err := h.svc.Authenticate(ctx, res.AccessToken); err == nil {
		t.Fatal("the old session must have ended")
	}
	if _, err := h.svc.Login(ctx, LoginInput{Identifier: "reset@example.com", Password: strongPassword, Device: ptr(phone(1))}); err == nil {
		t.Fatal("the old password must not work")
	}
	again, err := h.svc.Login(ctx, LoginInput{Identifier: "reset@example.com", Password: "Another-Strong-Pass-9", Device: ptr(phone(1))})
	if err != nil {
		t.Fatalf("login with the new password: %v", err)
	}
	if n := count(t, h, `SELECT COUNT(*) FROM devices WHERE user_id = $1 AND cool_off_until > now()`, again.User.ID); n != 1 {
		t.Fatalf("devices cooling off = %d, want 1", n)
	}
}

func TestProfileSecurityQuestionAlertsAndCheckup(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	res := h.signedUp(t, "prof@example.com", "+2348031230202")
	ctx := WithPrincipal(t.Context(), Principal{UserID: res.User.ID, DeviceID: res.Device.ID})

	// Profile: name and photo, bad photos refused, an empty string clears.
	name, photo := "  Toluwa ", "data:image/png;base64,iVBORw0KGgo="
	pr, err := h.svc.UpdateMe(ctx, &name, &photo)
	if err != nil || pr.User.PreferredName == nil || *pr.User.PreferredName != "Toluwa" || pr.Avatar == nil || *pr.Avatar != photo {
		t.Fatalf("update = %+v, %v", pr, err)
	}
	for _, bad := range []string{"data:image/gif;base64,AAAA", "https://example.com/a.png", "data:image/png;base64," + strings.Repeat("A", maxAvatarLength)} {
		if _, err := h.svc.UpdateMe(ctx, nil, &bad); err == nil {
			t.Fatalf("photo %.30q must be refused", bad)
		}
	}
	empty := ""
	if pr, err = h.svc.UpdateMe(ctx, &empty, &empty); err != nil || pr.Avatar != nil || pr.User.PreferredName != nil {
		t.Fatalf("clear = %+v, %v", pr, err)
	}

	// Security question: short answers refused; the answer is stored hashed, not as typed.
	if err := h.svc.SetSecurityQuestion(ctx, "First pet?", "ab"); err == nil {
		t.Fatal("a short answer must be refused")
	}
	if err := h.svc.SetSecurityQuestion(ctx, "First pet?", " Rex "); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := h.svc.pool.QueryRow(t.Context(), `SELECT security_answer_hash FROM users WHERE id = $1`, res.User.ID).Scan(&stored); err != nil || !strings.HasPrefix(stored, "$argon2id$") || strings.Contains(stored, "rex") {
		t.Fatalf("stored answer = %q, %v", stored, err)
	}

	// Alerts: new-device alerts cannot be turned off while the device is cooling off.
	if _, err := h.svc.pool.Exec(t.Context(), `UPDATE devices SET cool_off_until = now() + interval '1 hour' WHERE user_id = $1`, res.User.ID); err != nil {
		t.Fatal(err)
	}
	// The harness clock is real time, so the cool-off above is live.
	got, err := h.svc.SetAlertPreferences(ctx, AlertPreferences{LoginAlerts: false, NewDeviceAlerts: false, ThresholdMinor: 5_000_00})
	if err != nil || !got.NewDeviceAlerts || got.LoginAlerts {
		t.Fatalf("alerts = %+v, %v", got, err)
	}
	if back, _ := h.svc.GetAlertPreferences(ctx); back != got {
		t.Fatalf("read back %+v, want %+v", back, got)
	}
	if _, err := h.svc.SetAlertPreferences(ctx, AlertPreferences{ThresholdMinor: -1}); err == nil {
		t.Fatal("a negative threshold must be refused")
	}

	// Checkup: the question and the single device count, the PIN and Tier 2 do not yet.
	score, items, err := h.svc.Checkup(ctx)
	if err != nil || len(items) != 8 {
		t.Fatalf("checkup = %d %v", score, err)
	}
	done := map[string]bool{}
	total := 0
	for _, it := range items {
		done[it.ID] = it.Done
		total += it.Points
	}
	if !done["security_question_set"] || !done["single_device"] || done["kyc_tier_2"] || done["alerts_on"] || total != 100 {
		t.Fatalf("items = %v (points %d)", done, total)
	}

	// Unauthenticated calls are refused.
	if _, err := h.svc.GetAlertPreferences(t.Context()); err == nil {
		t.Fatal("must be refused")
	}
}
