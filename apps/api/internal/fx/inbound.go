package fx

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

var errNotDemo = problem.Forbidden().WithDetail("Demo controls are only for demo users.")

// InboundRequest simulates money arriving from outside (FX-3).
type InboundRequest struct {
	Account    uuid.UUID
	Amount     money.Money
	SenderName string
	SenderBank string
	Narration  string
}

// DemoInbound credits one of a demo customer's accounts as if another bank, or a foreign
// sender, had paid in. The money comes from the demo funding account through the ledger, so
// the books still balance. Naira over the EMTL threshold has the levy taken, as a real
// inflow would (FX-3), and the KYC balance cap applies as it does to any naira credit.
func (s *Service) DemoInbound(ctx context.Context, in InboundRequest) (accountsdb.Transaction, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return accountsdb.Transaction{}, problem.Unauthorized()
	}
	prof, err := s.customers.CustomerProfile(ctx, p.UserID)
	if err != nil {
		return accountsdb.Transaction{}, fmt.Errorf("customer profile: %w", err)
	}
	if !prof.IsDemo {
		return accountsdb.Transaction{}, errNotDemo
	}
	to, err := s.usable(ctx, p.UserID, in.Account)
	if err != nil {
		return accountsdb.Transaction{}, err
	}
	if in.Amount.Currency() != money.Currency(to.Currency) {
		return accountsdb.Transaction{}, problem.Validation(problem.Field("/amount/currency", "currency_mismatch", "This amount must be in "+to.Currency+"."))
	}
	if !in.Amount.IsPositive() {
		return accountsdb.Transaction{}, problem.Validation(problem.Field("/amount", "positive", "Enter an amount above zero."))
	}
	rules := s.limits.Rules()
	levy := rules.EMTL(in.Amount)
	balanceCap := rules.Tier(prof.KycTier).MaxBalanceMinor
	if to.Currency != string(money.NGN) {
		balanceCap = 0
	}

	var out accountsdb.Transaction
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, to.Currency)
		if err != nil {
			return err
		}
		legs := []ledger.Leg{ledger.Debit(src.ID, in.Amount), ledger.Credit(to.AccountID, in.Amount)}
		if levy.IsPositive() {
			levyAcct, err := ledger.SystemAccount(ctx, tx, ledger.KindLevyPayable, string(money.NGN))
			if err != nil {
				return err
			}
			net, err := in.Amount.Sub(levy)
			if err != nil {
				return err
			}
			legs = []ledger.Leg{ledger.Debit(src.ID, in.Amount), ledger.Credit(to.AccountID, net), ledger.Credit(levyAcct.ID, levy)}
		}
		ref := "INB-" + strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:12])
		posted, err := ledger.Post(ctx, tx, ledger.Entry{Kind: "demo_funding", Reference: ref, Legs: legs})
		if err != nil {
			return fmt.Errorf("post inbound: %w", err)
		}
		if after := accounts.BalanceAfter(posted, to.AccountID); balanceCap > 0 && after != nil && *after > balanceCap {
			return errMaxBalance
		}
		cp := api.Counterparty{Name: in.SenderName}
		if in.SenderBank != "" {
			cp.BankName = &in.SenderBank
		}
		narration := in.Narration
		if narration == "" {
			narration = "Transfer from " + in.SenderName
		}
		out, err = accounts.Record(ctx, tx, accounts.Line{
			UserID: p.UserID, AccountID: to.AccountID, Type: "transfer_in", Direction: "credit", Status: "completed",
			Amount: in.Amount, Fee: &levy, FeeCode: "emtl", Entry: &posted, Narration: narration, Reference: ref,
			Category: "transfers", Counterparty: cp,
		})
		return err
	})
	if errors.Is(err, ledger.ErrDuplicateEntry) {
		return accountsdb.Transaction{}, fmt.Errorf("inbound: %w", err)
	}
	return out, err
}
