package ledger

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/testdb"
)

// These tests write raw SQL on purpose: they prove the database refuses a broken entry on
// its own, whatever the posting engine above it does.

type posting struct {
	account uuid.UUID
	amount  int64
}

type db struct {
	t    *testing.T
	pool *pgxpool.Pool
}

func newDB(t *testing.T) *db { t.Helper(); return &db{t: t, pool: testdb.New(t)} }

func (d *db) system(kind, currency string) uuid.UUID {
	d.t.Helper()
	a, err := SystemAccount(d.t.Context(), d.pool, kind, currency)
	if err != nil {
		d.t.Fatal(err)
	}
	return a.ID
}

// customer creates a user with a current account in currency and returns the account.
func (d *db) customer(currency string) uuid.UUID {
	d.t.Helper()
	ctx := d.t.Context()
	user, account := uuid.Must(uuid.NewV7()), uuid.Must(uuid.NewV7())
	// A unique, valid phone number from the user's random ID bits.
	phone := fmt.Sprintf("+23480%08d", binary.BigEndian.Uint32(user[12:])%100_000_000)
	if _, err := d.pool.Exec(ctx, `INSERT INTO users (id, first_name, last_name, email, phone, date_of_birth,
		password_hash, terms_version, privacy_version, consent_accepted_at)
		VALUES ($1, 'Tolu', 'Adeyemi', $2, $3, '1996-04-12', 'x', '2026-10', '2026-10', now())`,
		user, user.String()+"@example.com", phone); err != nil {
		d.t.Fatalf("insert user: %v", err)
	}
	if _, err := d.pool.Exec(ctx, `INSERT INTO ledger_accounts (id, owner_type, owner_id, kind, currency, name)
		VALUES ($1, 'customer', $2, 'customer_current', $3, 'Current')`, account, user, currency); err != nil {
		d.t.Fatalf("insert account: %v", err)
	}
	return account
}

// post writes one entry with its postings in one transaction and returns the commit error.
// Balances after are not the point here; the posting engine computes them.
func (d *db) post(kind string, ps ...posting) error {
	d.t.Helper()
	return pgx.BeginFunc(d.t.Context(), d.pool, func(tx pgx.Tx) error {
		_, err := insertEntry(d.t.Context(), tx, kind, ps...)
		return err
	})
}

func insertEntry(ctx context.Context, tx pgx.Tx, kind string, ps ...posting) (uuid.UUID, error) {
	entry := uuid.Must(uuid.NewV7())
	if _, err := tx.Exec(ctx, `INSERT INTO journal_entries (id, kind, reference) VALUES ($1, $2, 'test')`, entry, kind); err != nil {
		return uuid.Nil, err
	}
	for _, p := range ps {
		if err := addPosting(ctx, tx, entry, p); err != nil {
			return uuid.Nil, err
		}
	}
	return entry, nil
}

func addPosting(ctx context.Context, tx pgx.Tx, entry uuid.UUID, p posting) error {
	_, err := tx.Exec(ctx, `INSERT INTO postings (id, entry_id, account_id, amount_minor, currency, balance_after_minor)
		SELECT $1, $2, id, $3, currency, 0 FROM ledger_accounts WHERE id = $4`,
		uuid.Must(uuid.NewV7()), entry, p.amount, p.account)
	return err
}

func wantRefused(t *testing.T, err error, fragment string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || !strings.Contains(pgErr.Message+pgErr.ConstraintName, fragment) {
		t.Fatalf("err = %v, want a database refusal mentioning %q", err, fragment)
	}
}

func TestABalancedEntryCommits(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	funding, tolu := d.system(KindDemoFunding, "NGN"), d.customer("NGN")
	// ₦5,000 of demo money to Tolu: debit the bank's funding account, credit the customer.
	if err := d.post("demo_funding", posting{funding, -500_000}, posting{tolu, 500_000}); err != nil {
		t.Fatalf("balanced entry: %v", err)
	}
	// Three legs are fine too: ₦1,000 out, ₦990 to the partner, ₦10 fee.
	fees, partner := d.system(KindFeeIncome, "NGN"), d.system(KindPartnerSettlement, "NGN")
	if err := d.post("transfer_external", posting{tolu, -100_000}, posting{partner, 99_000}, posting{fees, 1_000}); err != nil {
		t.Fatalf("three-leg entry: %v", err)
	}
}

func TestTheDatabaseRefusesUnbalancedEntries(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	funding, tolu := d.system(KindDemoFunding, "NGN"), d.customer("NGN")
	usdWallet := d.customer("USD")

	wantRefused(t, d.post("demo_funding", posting{funding, -500_000}, posting{tolu, 499_999}), "unbalanced: NGN nets to -1")
	wantRefused(t, d.post("demo_funding", posting{tolu, 500_000}), "needs at least 2")
	wantRefused(t, d.post("demo_funding"), "needs at least 2")
	// Netting to zero overall is not enough: each currency must balance on its own, so a
	// conversion has to go through the FX position accounts.
	wantRefused(t, d.post("fx_conversion", posting{tolu, -10_000}, posting{usdWallet, 10_000}), "unbalanced")
	if err := d.post("fx_conversion",
		posting{tolu, -150_000}, posting{d.system(KindFXPosition, "NGN"), 150_000},
		posting{d.system(KindFXPosition, "USD"), -100}, posting{usdWallet, 100},
	); err != nil {
		t.Fatalf("conversion through the FX positions: %v", err)
	}
}

func TestAPostingMustBeInItsAccountsCurrency(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	tolu := d.customer("NGN")
	err := pgx.BeginFunc(t.Context(), d.pool, func(tx pgx.Tx) error {
		entry, err := insertEntry(t.Context(), tx, "demo_funding")
		if err != nil {
			return err
		}
		_, err = tx.Exec(t.Context(), `INSERT INTO postings (id, entry_id, account_id, amount_minor, currency, balance_after_minor)
			VALUES ($1, $2, $3, 100, 'USD', 0)`, uuid.Must(uuid.NewV7()), entry, tolu)
		return err
	})
	wantRefused(t, err, "postings_account_id_currency_fkey")
}

func TestHistoryIsAppendOnlyAndClosedEntriesStayClosed(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	ctx := t.Context()
	funding, tolu := d.system(KindDemoFunding, "NGN"), d.customer("NGN")
	var entry uuid.UUID
	if err := pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		var err error
		entry, err = insertEntry(ctx, tx, "demo_funding", posting{funding, -500_000}, posting{tolu, 500_000})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{
		"UPDATE postings SET amount_minor = 1 WHERE entry_id = $1",
		"DELETE FROM postings WHERE entry_id = $1",
		"UPDATE journal_entries SET reference = 'edited' WHERE id = $1",
		"DELETE FROM journal_entries WHERE id = $1",
	} {
		_, err := d.pool.Exec(ctx, sql, entry)
		wantRefused(t, err, "append-only")
	}
	// A later transaction cannot slip a balanced pair into the committed entry.
	err := pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		if err := addPosting(ctx, tx, entry, posting{funding, -1}); err != nil {
			return err
		}
		return addPosting(ctx, tx, entry, posting{tolu, 1})
	})
	wantRefused(t, err, "is closed")

	// Inside a savepoint (nested transaction) the entry's own postings are still accepted.
	if err := pgx.BeginFunc(ctx, d.pool, func(tx pgx.Tx) error {
		return pgx.BeginFunc(ctx, tx, func(sp pgx.Tx) error {
			_, err := insertEntry(ctx, sp, "demo_funding", posting{funding, -1}, posting{tolu, 1})
			return err
		})
	}); err != nil {
		t.Fatalf("entry posted in a savepoint: %v", err)
	}
}

func TestAccountRulesHoldInTheDatabase(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	ctx := t.Context()
	tolu := d.customer("NGN")
	for sql, fragment := range map[string]string{
		// No customer deposit below zero, and holds only reduce what can be spent.
		"UPDATE ledger_accounts SET balance_minor = -1, available_minor = -1 WHERE id = $1": "ledger_accounts_check",
		"UPDATE ledger_accounts SET available_minor = 10 WHERE id = $1":                     "ledger_accounts_check",
	} {
		_, err := d.pool.Exec(ctx, sql, tolu)
		wantRefused(t, err, fragment)
	}
	// A second NGN current account for the same customer, and a system account with an owner.
	_, err := d.pool.Exec(ctx, `INSERT INTO ledger_accounts (id, owner_type, owner_id, kind, currency, name)
		SELECT $1, 'customer', owner_id, 'customer_current', 'NGN', 'Again' FROM ledger_accounts WHERE id = $2`, uuid.Must(uuid.NewV7()), tolu)
	wantRefused(t, err, "ledger_accounts_customer")
	_, err = d.pool.Exec(ctx, `INSERT INTO ledger_accounts (id, owner_type, owner_id, kind, currency, name)
		SELECT $1, 'system', owner_id, 'fee_income', 'NGN', 'Fees' FROM ledger_accounts WHERE id = $2`, uuid.Must(uuid.NewV7()), tolu)
	wantRefused(t, err, "ledger_accounts_check")
	// A manual adjustment needs a maker-checker approval.
	wantRefused(t, d.post("manual_adjustment", posting{d.system(KindSuspense, "NGN"), -1}, posting{tolu, 1}), "journal_entries_check")
}

func TestEverySystemAccountIsSeededOnce(t *testing.T) {
	t.Parallel()
	d := newDB(t)
	rows, err := d.pool.Query(t.Context(),
		"SELECT kind, currency, id::text, balance_minor FROM ledger_accounts WHERE owner_type = 'system' ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := map[string]bool{}
	for rows.Next() {
		var kind, currency, id string
		var balance int64
		if err := rows.Scan(&kind, &currency, &id, &balance); err != nil {
			t.Fatal(err)
		}
		if balance != 0 || !strings.HasPrefix(id, "01900000-0000-7000-8000-5a") {
			t.Errorf("%s %s: id %s balance %d", kind, currency, id, balance)
		}
		seen[kind+" "+currency] = true
	}
	if len(seen) != 26 {
		t.Errorf("%d system accounts, want 26", len(seen))
	}
	// Every currency can hold suspense, earn fees, be converted and settle with a partner.
	for _, cur := range []string{"NGN", "USD", "GBP", "EUR"} {
		for _, kind := range []string{KindSuspense, KindFeeIncome, KindFXPosition, KindPartnerSettlement, KindDemoFunding} {
			if !seen[kind+" "+cur] {
				t.Errorf("no %s account in %s", kind, cur)
			}
		}
	}
	if _, err := SystemAccount(t.Context(), d.pool, KindAjoEscrow, "GBP"); !errors.Is(err, ErrNoSystemAccount) {
		t.Errorf("GBP ajo escrow: err = %v, want ErrNoSystemAccount", err)
	}
}
