package transfers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/cop"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/partners"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers/transfersdb"
)

// Problems with the mock bank's codes and wording.
var (
	errUnknownBank            = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Pick a bank from the list")
	errNoSuchAccountElsewhere = problem.New(http.StatusNotFound, "account_not_found", "We could not find that account").
					WithDetail("Check the account number and the bank.")
)

// Banks is the bank picker's directory (GET /v1/banks).
func Banks() []api.Bank {
	bs := partners.Banks()
	out := make([]api.Bank, len(bs))
	for i, b := range bs {
		out[i] = api.Bank{Code: b.Code, Name: b.Name, ShortName: &b.ShortName}
	}
	return out
}

// ResolvePayee looks up who a payment would go to before the customer types an amount:
// a Nem user by @nemtag, phone or account number, or an account at another bank by name
// enquiry. For a bank account it also runs Confirmation of Payee against the name the
// customer typed, so they see "close match" or "no match" before any money moves.
func (s *Service) ResolvePayee(ctx context.Context, q api.PayeeQuery) (api.ResolvedPayee, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return api.ResolvedPayee{}, problem.Unauthorized()
	}
	out, err := s.resolvePayee(ctx, p, q)
	if err != nil {
		return out, err
	}
	b, err := s.q.FindBeneficiary(ctx, transfersdb.FindBeneficiaryParams{UserID: p.UserID, BankCode: out.BankCode, AccountNumber: out.AccountNumber})
	switch {
	case err == nil:
		out.IsSavedBeneficiary, out.BeneficiaryId = true, &b.ID
	case !errors.Is(err, pgx.ErrNoRows):
		return out, fmt.Errorf("find beneficiary: %w", err)
	}
	return out, nil
}

func (s *Service) resolvePayee(ctx context.Context, p identity.Principal, q api.PayeeQuery) (api.ResolvedPayee, error) {
	kind, err := q.Discriminator()
	if err != nil {
		return api.ResolvedPayee{}, fmt.Errorf("payee query: %w", err)
	}
	if kind == "nem" {
		n, err := q.AsNemPayeeQuery()
		if err != nil {
			return api.ResolvedPayee{}, fmt.Errorf("payee query: %w", err)
		}
		r, err := s.findNemUser(ctx, n.Query)
		if err != nil {
			return api.ResolvedPayee{}, err
		}
		return nemPayee(p.UserID, r, nil)
	}

	b, err := q.AsBankPayeeQuery()
	if err != nil {
		return api.ResolvedPayee{}, fmt.Errorf("payee query: %w", err)
	}
	if b.BankCode == partners.NemBankCode {
		r, err := s.accounts.ResolveNuban(ctx, b.AccountNumber)
		if err != nil {
			return api.ResolvedPayee{}, err
		}
		return nemPayee(p.UserID, r, b.ExpectedName)
	}
	bank, ok := partners.BankByCode(b.BankCode)
	if !ok {
		return api.ResolvedPayee{}, errUnknownBank
	}
	acct, err := s.partner.NameEnquiry(ctx, bank.Code, b.AccountNumber)
	if errors.Is(err, partners.ErrAccountNotFound) {
		return api.ResolvedPayee{}, errNoSuchAccountElsewhere
	}
	if err != nil {
		return api.ResolvedPayee{}, fmt.Errorf("name enquiry: %w", err)
	}
	// Beneficiaries arrive in T25.6; until then nothing is saved.
	return api.ResolvedPayee{
		Kind: api.ResolvedPayeeKindBank, Name: acct.Name, BankCode: bank.Code, BankName: bank.Name,
		AccountNumber: acct.AccountNumber, NameMatch: forced(nameMatch(b.ExpectedName, acct.Name), acct.NameCheck),
	}, nil
}

// findNemUser reads a ten-digit query as a Nem account number and anything else as an
// @nemtag or phone, the three ways TRF-1 lets a customer name a Nem payee.
func (s *Service) findNemUser(ctx context.Context, query string) (accounts.Recipient, error) {
	query = strings.TrimSpace(query)
	if len(query) == 10 && strings.Trim(query, "0123456789") == "" {
		return s.accounts.ResolveNuban(ctx, query)
	}
	userID, err := s.customers.FindCustomer(ctx, query)
	if err != nil {
		return accounts.Recipient{}, err
	}
	return s.accounts.ResolveCustomer(ctx, userID)
}

func nemPayee(caller uuid.UUID, r accounts.Recipient, expected *string) (api.ResolvedPayee, error) {
	if r.UserID == caller {
		return api.ResolvedPayee{}, errOwnAccount
	}
	userID := r.UserID
	return api.ResolvedPayee{
		Kind: api.ResolvedPayeeKindNem, Name: r.Name, Nemtag: r.Nemtag, UserId: &userID,
		BankCode: accounts.BankCode, BankName: accounts.BankName, AccountNumber: r.AccountNumber,
		NameMatch: nameMatch(expected, r.Name),
	}, nil
}

// forced applies the sandbox's name-check override, so a demo can show every warning.
func forced(m *api.NameMatch, mode partners.NameCheck) *api.NameMatch {
	switch {
	case m == nil:
		return nil
	case mode == partners.AlwaysMatch:
		m.Result, m.Confidence = api.Match, 1
	case mode == partners.AlwaysNoMatch:
		m.Result, m.Confidence = api.NoMatch, 0
	}
	return m
}

// nameMatch runs Confirmation of Payee when the customer typed a name.
func nameMatch(expected *string, actual string) *api.NameMatch {
	if expected == nil || strings.TrimSpace(*expected) == "" {
		return nil
	}
	o := cop.Compare(*expected, actual)
	e := *expected
	return &api.NameMatch{Result: api.NameMatchResult(o.Result), Confidence: float32(o.Confidence), ExpectedName: &e}
}
