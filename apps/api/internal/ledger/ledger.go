// Package ledger is Nem Bank's double-entry ledger (ADR-4): accounts, journal entries and
// postings in integer minor units, signed (credits positive, debits negative).
//
// The database enforces the core rules on its own (migration 00009): each entry has two or
// more postings that net to zero in every currency (checked at COMMIT), a posting is in
// its account's currency, a committed entry cannot gain postings, history is append-only,
// and no customer deposit goes below zero. The posting engine builds on these; it does not
// replace them.
package ledger

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/ledgerdb"
)

// System account kinds (contract LedgerAccountKind), seeded per currency by migration 00009.
const (
	KindSuspense          = "suspense"
	KindFeeIncome         = "fee_income"
	KindFXPosition        = "fx_position"
	KindPartnerSettlement = "partner_settlement"
	KindCardSettlement    = "card_settlement"
	KindInterestExpense   = "interest_expense"
	KindInterestIncome    = "interest_income"
	KindLevyPayable       = "levy_payable"
	KindAjoEscrow         = "ajo_escrow"
	KindDemoFunding       = "demo_funding"
)

// ErrNoSystemAccount means the bank has no account of that kind in that currency.
var ErrNoSystemAccount = errors.New("ledger: no system account of that kind and currency")

// SystemAccount returns the bank's account of a kind in a currency.
func SystemAccount(ctx context.Context, db ledgerdb.DBTX, kind, currency string) (ledgerdb.LedgerAccount, error) {
	a, err := ledgerdb.New(db).GetSystemAccount(ctx, ledgerdb.GetSystemAccountParams{Kind: kind, Currency: currency})
	if errors.Is(err, pgx.ErrNoRows) {
		return ledgerdb.LedgerAccount{}, fmt.Errorf("%w: %s %s", ErrNoSystemAccount, kind, currency)
	}
	if err != nil {
		return ledgerdb.LedgerAccount{}, fmt.Errorf("load system account: %w", err)
	}
	return a, nil
}
