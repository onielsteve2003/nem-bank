package identity

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity/identitydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// ErrNoSuchCustomer means no customer has that @nemtag or phone (the mock bank's wording).
var ErrNoSuchCustomer = problem.New(http.StatusNotFound, "account_not_found", "No Nem user matches that")

// FindCustomer finds a customer by @nemtag ("@ada", "ada") or Nigerian phone ("0803…",
// "+234803…", "234803…"), for paying a Nem user (TRF-1).
func (s *Service) FindCustomer(ctx context.Context, handle string) (uuid.UUID, error) {
	h := strings.TrimSpace(handle)
	var arg identitydb.FindCustomerByHandleParams
	if phone, ok := phoneHandle(h); ok {
		arg.Phone = &phone
	} else {
		tag := strings.ToLower(strings.TrimPrefix(h, "@"))
		arg.Nemtag = &tag
	}
	id, err := s.q.FindCustomerByHandle(ctx, arg)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNoSuchCustomer
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("find customer: %w", err)
	}
	return id, nil
}

// phoneHandle turns a Nigerian mobile number in any usual spelling into E.164.
func phoneHandle(h string) (string, bool) {
	d := strings.NewReplacer(" ", "", "-", "", "(", "", ")", "").Replace(h)
	d = strings.TrimPrefix(d, "+")
	switch {
	case len(d) == 11 && strings.HasPrefix(d, "0"):
		d = "234" + d[1:]
	case len(d) == 13 && strings.HasPrefix(d, "234"):
	default:
		return "", false
	}
	if strings.Trim(d, "0123456789") != "" {
		return "", false
	}
	return "+" + d, true
}
