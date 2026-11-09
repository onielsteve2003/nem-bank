package ledger

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/ledgerdb"
)

// BalancesBefore returns each account's ledger balance just before at: the running
// balance after its last earlier posting, or zero for an account with none.
func BalancesBefore(ctx context.Context, db ledgerdb.DBTX, accounts []uuid.UUID, at time.Time) (map[uuid.UUID]int64, error) {
	rows, err := ledgerdb.New(db).BalancesBefore(ctx, ledgerdb.BalancesBeforeParams{Ids: accounts, Before: at})
	if err != nil {
		return nil, fmt.Errorf("balances before: %w", err)
	}
	out := make(map[uuid.UUID]int64, len(rows))
	for _, r := range rows {
		out[r.AccountID] = r.BalanceMinor
	}
	return out, nil
}

// AccountPostings lists an account's postings in [since, until), oldest first.
func AccountPostings(ctx context.Context, db ledgerdb.DBTX, account uuid.UUID, since, until time.Time) ([]ledgerdb.ListAccountPostingsRow, error) {
	rows, err := ledgerdb.New(db).ListAccountPostings(ctx, ledgerdb.ListAccountPostingsParams{
		AccountID: account, Since: since, Until: until,
	})
	if err != nil {
		return nil, fmt.Errorf("list postings: %w", err)
	}
	return rows, nil
}
