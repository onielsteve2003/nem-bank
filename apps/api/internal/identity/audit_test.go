package identity

import (
	"slices"
	"testing"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
)

func TestSecurityChangesAreInTheAuditChain(t *testing.T) {
	t.Parallel()
	h := newHarness(t)
	ctx, first := h.withPin(t)

	ipad := phone(2)
	second, err := h.svc.Login(t.Context(), LoginInput{Identifier: "tolu@example.com", Password: strongPassword, Device: &ipad})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.svc.RevokeDevice(ctx, second.Device.ID); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.ResetPin(ctx, h.stepUp(t, first.User.ID, "pin_reset"), "4815"); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.SetDuressPin(ctx, h.stepUp(t, first.User.ID, "pin_reset"), "9731"); err != nil {
		t.Fatal(err)
	}
	// A refused change (duress PIN equal to the PIN) leaves no entry: it rolled back.
	_ = h.svc.SetDuressPin(ctx, h.stepUp(t, first.User.ID, "pin_reset"), "4815")

	rows, err := h.svc.pool.Query(t.Context(), `SELECT action FROM audit_log ORDER BY seq`)
	if err != nil {
		t.Fatal(err)
	}
	var actions []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			t.Fatal(err)
		}
		actions = append(actions, a)
	}
	want := []string{"device.bind", "device.bind", "device.revoke", "pin.reset", "duress_pin.set"}
	if rows.Err() != nil || !slices.Equal(actions, want) {
		t.Fatalf("actions = %v, want %v", actions, want)
	}
	v, err := audit.Verify(t.Context(), h.svc.pool, 0, 0)
	if err != nil || !v.Valid || v.Checked != 5 {
		t.Fatalf("verify = %+v, %v", v, err)
	}
}
