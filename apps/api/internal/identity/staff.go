package identity

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
)

// DevicesFor lists a customer's bound devices for a staff member (ADM-3). Nothing is marked as
// the "current" device: staff are not on one.
func (s *Service) DevicesFor(ctx context.Context, userID uuid.UUID) ([]api.Device, error) {
	ds, err := s.q.ListLiveDevices(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	now := s.now()
	out := make([]api.Device, len(ds))
	for i, d := range ds {
		out[i] = deviceJSON(d, uuid.Nil, now)
	}
	return out, nil
}
