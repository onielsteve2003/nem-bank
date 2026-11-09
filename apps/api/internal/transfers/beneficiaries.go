package transfers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/pagination"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// ErrBeneficiaryNotFound is the 404 for a beneficiary the caller does not have.
var ErrBeneficiaryNotFound = problem.NotFound("Beneficiary")

func beneficiaryExists(name string) error {
	return problem.New(http.StatusConflict, "beneficiary_exists", "Already saved").
		WithDetailf("%s is already in your beneficiaries.", name)
}

// saveBeneficiary saves dest for the customer, starting its cooling-off. saved is false
// when it was already saved.
func (s *Service) saveBeneficiary(ctx context.Context, q *transfersdb.Queries, userID uuid.UUID, dest target, favourite bool, nickname *string) (transfersdb.Beneficiary, bool, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return transfersdb.Beneficiary{}, false, fmt.Errorf("beneficiary id: %w", err)
	}
	kind := "bank"
	if dest.internal() {
		kind = "nem"
	}
	b, err := q.InsertBeneficiary(ctx, transfersdb.InsertBeneficiaryParams{
		ID: id, UserID: userID, Kind: kind, Name: dest.party.Name, Nickname: nickname, Nemtag: dest.party.Nemtag,
		BankCode: dest.party.BankCode, BankName: dest.party.BankName, AccountNumber: dest.accountNumber(), Favourite: favourite,
		CoolingOffUntil: ptr(s.now().Add(s.limits.Rules().BeneficiaryCoolingOff)),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return b, false, nil
	}
	if err != nil {
		return b, false, fmt.Errorf("save beneficiary: %w", err)
	}
	return b, true, nil
}

// beneficiaryDestination is where a saved beneficiary is paid.
func beneficiaryDestination(b transfersdb.Beneficiary) (api.TransferDestination, error) {
	var d api.TransferDestination
	var err error
	if b.Kind == "nem" {
		err = d.FromNemDestination(api.NemDestination{Kind: "nem", AccountNumber: b.AccountNumber})
	} else {
		err = d.FromBankDestination(api.BankDestination{Kind: "bank", BankCode: b.BankCode, AccountNumber: b.AccountNumber, AccountName: b.Name})
	}
	if err != nil {
		return d, fmt.Errorf("beneficiary destination: %w", err)
	}
	return d, nil
}

// BeneficiaryJSON is the contract's Beneficiary.
func BeneficiaryJSON(b transfersdb.Beneficiary) api.Beneficiary {
	return api.Beneficiary{
		Id: b.ID, Kind: api.BeneficiaryKind(b.Kind), Name: b.Name, Nickname: b.Nickname, Nemtag: b.Nemtag,
		BankCode: b.BankCode, BankName: b.BankName, AccountNumber: b.AccountNumber, Favourite: b.Favourite,
		CoolingOffUntil: utc(b.CoolingOffUntil), LastPaidAt: utc(b.LastPaidAt), CreatedAt: b.CreatedAt.UTC(),
	}
}

// CreateBeneficiary saves a payee (TRF-8). The name saved is the bank's, from name enquiry.
func (s *Service) CreateBeneficiary(ctx context.Context, d api.CreateBeneficiaryRequest_Destination, nickname *string, favourite bool) (transfersdb.Beneficiary, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return transfersdb.Beneficiary{}, problem.Unauthorized()
	}
	// The request's destination is a Nem or bank TransferDestination by another name.
	raw, err := json.Marshal(d)
	if err != nil {
		return transfersdb.Beneficiary{}, fmt.Errorf("destination: %w", err)
	}
	var dest api.TransferDestination
	if err := json.Unmarshal(raw, &dest); err != nil {
		return transfersdb.Beneficiary{}, fmt.Errorf("destination: %w", err)
	}
	t, err := s.resolveAccount(ctx, dest)
	if err != nil {
		return transfersdb.Beneficiary{}, err
	}
	if t.internal() && t.nem.UserID == p.UserID {
		return transfersdb.Beneficiary{}, errOwnAccount
	}
	b, saved, err := s.saveBeneficiary(ctx, s.q, p.UserID, t, favourite, cleanNickname(nickname))
	if err != nil {
		return b, err
	}
	if !saved {
		return b, beneficiaryExists(t.party.Name)
	}
	return b, nil
}

func cleanNickname(n *string) *string {
	if n == nil || strings.TrimSpace(*n) == "" {
		return nil
	}
	v := strings.TrimSpace(*n)
	return &v
}

// ListBeneficiaries pages the caller's beneficiaries: favourites first, then most recently
// paid. q matches name, nickname, @nemtag, account number or bank.
func (s *Service) ListBeneficiaries(ctx context.Context, favourite *bool, query, cursor *string, limit *int) ([]transfersdb.Beneficiary, api.PageInfo, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return nil, api.PageInfo{}, problem.Unauthorized()
	}
	off, err := decodeOffset(cursor)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	n := pagination.Limit(limit)
	in := transfersdb.ListBeneficiariesParams{UserID: p.UserID, Off: off, Lim: int32(n + 1)} //nolint:gosec // n ≤ pagination.MaxLimit
	if favourite != nil {
		in.Favourite = pgtype.Bool{Bool: *favourite, Valid: true}
	}
	if query != nil && strings.TrimSpace(*query) != "" {
		v := strings.TrimSpace(*query)
		in.Q = &v
	}
	rows, err := s.q.ListBeneficiaries(ctx, in)
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("list beneficiaries: %w", err)
	}
	rows, page := offsetPage(rows, n, off)
	return rows, page, nil
}

// UpdateBeneficiary renames (an empty nickname clears it) or (un)favourites one.
func (s *Service) UpdateBeneficiary(ctx context.Context, id uuid.UUID, nickname *string, favourite *bool) (transfersdb.Beneficiary, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return transfersdb.Beneficiary{}, problem.Unauthorized()
	}
	in := transfersdb.UpdateBeneficiaryParams{ID: id, UserID: p.UserID, SetNickname: nickname != nil, Nickname: cleanNickname(nickname)}
	if favourite != nil {
		in.Favourite = pgtype.Bool{Bool: *favourite, Valid: true}
	}
	b, err := s.q.UpdateBeneficiary(ctx, in)
	if errors.Is(err, pgx.ErrNoRows) {
		return b, ErrBeneficiaryNotFound
	}
	if err != nil {
		return b, fmt.Errorf("update beneficiary: %w", err)
	}
	return b, nil
}

// DeleteBeneficiary removes one. Past transfers keep their recipient; a schedule paying
// them keeps working (it stores the account, not the beneficiary).
func (s *Service) DeleteBeneficiary(ctx context.Context, id uuid.UUID) error {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return problem.Unauthorized()
	}
	n, err := s.q.DeleteBeneficiary(ctx, transfersdb.DeleteBeneficiaryParams{ID: id, UserID: p.UserID})
	if err != nil {
		return fmt.Errorf("delete beneficiary: %w", err)
	}
	if n == 0 {
		return ErrBeneficiaryNotFound
	}
	return nil
}

// Offset cursors page the short, multi-key-ordered lists (beneficiaries, schedules).
const offsetPrefix = "o1:"

func decodeOffset(c *string) (int32, error) {
	if c == nil || *c == "" {
		return 0, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(*c)
	if err != nil || !strings.HasPrefix(string(b), offsetPrefix) {
		return 0, pagination.ErrInvalidCursor
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(string(b), offsetPrefix), 10, 32)
	if err != nil || n < 0 {
		return 0, pagination.ErrInvalidCursor
	}
	return int32(n), nil
}

func offsetPage[T any](rows []T, n int, off int32) ([]T, api.PageInfo) {
	if len(rows) <= n {
		return rows, api.PageInfo{}
	}
	next := base64.RawURLEncoding.EncodeToString([]byte(offsetPrefix + strconv.Itoa(int(off)+n)))
	return rows[:n], api.PageInfo{NextCursor: &next}
}

func utc(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := t.UTC()
	return &v
}
