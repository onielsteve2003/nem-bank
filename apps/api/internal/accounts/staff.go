package accounts

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
)

// The methods in this file serve the staff console (T30.5): they read any customer's data, so
// the caller must already have checked the staff member's role. They never write.

// ViewsFor lists a customer's accounts, naira first, for a staff member.
func (s *Service) ViewsFor(ctx context.Context, userID uuid.UUID) ([]View, error) {
	prof, err := s.customers.CustomerProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListCustomerAccounts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list accounts: %w", err)
	}
	out := make([]View, 0, len(rows))
	for _, r := range rows {
		c := money.Currency(r.Currency)
		out = append(out, s.view(accountsdb.CustomerAccount{
			AccountID: r.AccountID, UserID: r.UserID, Currency: r.Currency, Kind: r.Kind, AccountNumber: r.AccountNumber,
			Nickname: r.Nickname, Status: r.Status, OpenedAt: r.OpenedAt,
		}, money.New(r.BalanceMinor, c), money.New(r.AvailableMinor, c), prof))
	}
	return out, nil
}

// AccountJSON is the contract's Account for a View.
func AccountJSON(v View) (api.Account, error) { return accountJSON(v) }

// StaffTransactionDetail is the contract's detail of one customer's transaction, for a dispute
// reviewer. A transaction that is not the customer's is "not found".
func (s *Service) StaffTransactionDetail(ctx context.Context, userID, id uuid.UUID) (api.TransactionDetail, error) {
	t, err := s.q.GetTransaction(ctx, accountsdb.GetTransactionParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return api.TransactionDetail{}, ErrTransactionNotFound
	}
	if err != nil {
		return api.TransactionDetail{}, fmt.Errorf("load transaction: %w", err)
	}
	d := Detail{
		Transaction: t,
		CanDispute:  t.Direction == "debit" && t.Status == "completed" && s.now().Sub(t.CreatedAt) <= disputeWindow,
		CanRepeat:   t.Type == "transfer_out" && t.TransferID != nil,
	}
	if t.TransferID != nil && s.timelines != nil {
		if d.Timeline, err = s.timelines(ctx, *t.TransferID); err != nil {
			return api.TransactionDetail{}, err
		}
	}
	if len(d.Timeline) == 0 {
		d.Timeline = []api.TimelineEvent{{Status: t.Status, Label: statusLabel(t.Status), At: t.UpdatedAt.UTC()}}
	}
	return detailJSON(d)
}
