package identity

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
)

// New-device cool-off (AUTH-8). For 24 hours after a login binds a new device, money
// leaving the account from that device is capped lower, and every transfer from it is
// stepped up with the reason new_device (the mock bank's rules, transfers.ts). Someone who
// stole a password and logged in elsewhere gets a small, slow window, and the customer's
// other devices were alerted when it was bound (identity.device_bound).
//
// Identity owns the rule; the limits and risk engines (M25) read it through CoolOff.

// NewDeviceDailyLimitMinor is the cool-off daily cap in kobo: ₦50,000, the console's
// default for BankConfig.new_device.daily_limit. It moves to bank configuration (ADM-8).
const NewDeviceDailyLimitMinor int64 = 50_000_00

// CoolOff is the calling device's cool-off.
type CoolOff struct {
	Active bool
	// Until is when it ends; nil for a device that never had one (the sign-up device).
	Until *time.Time
	// DailyLimitMinor caps outgoing NGN per day while Active. The limits engine applies
	// the lowest of this, the KYC tier cap and the customer's own limit (LimitStatus).
	DailyLimitMinor int64
	// Reason is the risk reason code transfers carry while Active.
	Reason string
}

// CoolOff reports the cool-off of the device the caller's session is on.
func (s *Service) CoolOff(ctx context.Context) (CoolOff, error) {
	p, err := principal(ctx)
	if err != nil {
		return CoolOff{}, err
	}
	d, err := s.q.GetLiveDevice(ctx, identitydb.GetLiveDeviceParams{ID: p.DeviceID, UserID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return CoolOff{}, ErrSessionRevoked
	}
	if err != nil {
		return CoolOff{}, fmt.Errorf("load device: %w", err)
	}
	return coolOffOf(d, s.now()), nil
}

func coolOffOf(d identitydb.Device, now time.Time) CoolOff {
	c := CoolOff{Until: d.CoolOffUntil}
	if d.CoolOffUntil != nil && now.Before(*d.CoolOffUntil) {
		c.Active = true
		c.DailyLimitMinor = NewDeviceDailyLimitMinor
		c.Reason = "new_device"
	}
	return c
}
