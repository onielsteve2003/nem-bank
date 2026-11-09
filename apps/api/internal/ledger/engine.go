package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/ledgerdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// The posting engine. Every change to a balance goes through Post, PlaceHold or
// ReleaseHold, inside the caller's transaction, so a transfer can post its entry and write
// its outbox event atomically. Concurrency rests on three things:
//
//   - Row locks, always taken in the same order: the entry's accounts by ID, then its
//     holds by ID. Two entries that share accounts wait for each other; they never deadlock.
//   - Balances are cached on the account row and written under that lock with a version
//     check, so a stale read can never overwrite a newer balance.
//   - The database's own rules (migration 00009) still apply at COMMIT, so an engine bug
//     fails the transaction instead of corrupting the ledger.

// ErrInsufficientFunds means a customer deposit account would go below zero available
// (status and code match the mock bank, apps/mobile/src/data/mock/ledger/ledger.ts).
var ErrInsufficientFunds = problem.New(http.StatusUnprocessableEntity, "insufficient_funds", "Insufficient funds")

// Programmer errors: a caller built an impossible entry. They surface as 500s.
var (
	ErrUnbalanced     = errors.New("ledger: entry does not net to zero in every currency")
	ErrTooFewLegs     = errors.New("ledger: an entry needs at least two non-zero legs")
	ErrUnknownAccount = errors.New("ledger: no such account")
	ErrWrongCurrency  = errors.New("ledger: amount is not in the account's currency")
	ErrStaleBalance   = errors.New("ledger: account changed under its lock")
	ErrBadHold        = errors.New("ledger: hold must be a positive amount")
)

// ErrDuplicateEntry means an entry with the same idempotency key already posted. Nothing
// was written and the transaction is still usable; callers look up the earlier entry.
var ErrDuplicateEntry = errors.New("ledger: entry already posted")

// ErrHoldClosed means the hold was already released or captured.
var ErrHoldClosed = errors.New("ledger: hold is no longer active")

// Leg is one side of an entry, in the contract's sign convention: credits are positive,
// debits negative.
type Leg struct {
	Account uuid.UUID
	Amount  money.Money
}

// Debit and Credit build legs without sign mistakes at the call site. amount is positive.
func Debit(account uuid.UUID, amount money.Money) Leg {
	return Leg{Account: account, Amount: money.New(-amount.Amount(), amount.Currency())}
}

// Credit is the positive side of an entry; see Debit.
func Credit(account uuid.UUID, amount money.Money) Leg { return Leg{Account: account, Amount: amount} }

// Entry is one business movement of money.
type Entry struct {
	// Kind is a contract JournalEntryKind ("transfer_internal", "fee", ...).
	Kind string
	// Reference names what the entry is for: a transfer ID, a card authorisation.
	Reference string
	// IdempotencyKey identifies the business operation; empty for none. A second Post with
	// the same key writes nothing and returns ErrDuplicateEntry.
	IdempotencyKey string
	// ApprovalID is the maker-checker approval; required for manual adjustments.
	ApprovalID *uuid.UUID
	// Metadata holds IDs and codes only, never PII.
	Metadata map[string]any
	Legs     []Leg
	// Capture lists holds this entry settles. Each is closed as captured and its amount is
	// returned to available before the legs apply, so the held money pays for the debit.
	Capture []uuid.UUID
}

// Posted is the written entry.
type Posted struct {
	EntryID   uuid.UUID
	CreatedAt time.Time
	Postings  []ledgerdb.Posting
}

// Balances is an account's cached position.
type Balances struct {
	Ledger    money.Money
	Available money.Money
	// Version moves on every write, so a reader can tell a balance it holds is stale.
	Version int64
}

// position is a locked account and its balances as the entry changes them.
type position struct {
	row       ledgerdb.LedgerAccount
	balance   int64
	available int64
}

// Post writes e in tx: it locks the accounts, checks funds, writes the entry and its
// postings and updates the cached balances. On any error the caller rolls tx back.
func Post(ctx context.Context, tx pgx.Tx, e Entry) (Posted, error) {
	if err := checkLegs(e.Legs); err != nil {
		return Posted{}, err
	}
	q := ledgerdb.New(tx)
	ids := make([]uuid.UUID, 0, len(e.Legs))
	for _, l := range e.Legs {
		ids = append(ids, l.Account)
	}
	pos, err := lockAccounts(ctx, q, ids)
	if err != nil {
		return Posted{}, err
	}
	for _, l := range e.Legs {
		if pos[l.Account].row.Currency != string(l.Amount.Currency()) {
			return Posted{}, fmt.Errorf("%w: %s on account %s", ErrWrongCurrency, l.Amount.Currency(), l.Account)
		}
	}

	meta, err := metadataJSON(e.Metadata)
	if err != nil {
		return Posted{}, err
	}
	entryID, err := uuid.NewV7()
	if err != nil {
		return Posted{}, fmt.Errorf("entry id: %w", err)
	}
	key := pgtype.Text{String: e.IdempotencyKey, Valid: e.IdempotencyKey != ""}
	entry, err := q.InsertEntry(ctx, ledgerdb.InsertEntryParams{
		ID: entryID, Kind: e.Kind, Reference: e.Reference, IdempotencyKey: key, ApprovalID: e.ApprovalID, Metadata: meta,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Posted{}, ErrDuplicateEntry
	}
	if err != nil {
		return Posted{}, fmt.Errorf("insert entry: %w", err)
	}

	if err := captureHolds(ctx, q, pos, e.Capture, entryID); err != nil {
		return Posted{}, err
	}

	postings := make([]ledgerdb.Posting, 0, len(e.Legs))
	for _, l := range e.Legs {
		p := pos[l.Account]
		if p.balance, err = add(p.balance, l.Amount.Amount()); err != nil {
			return Posted{}, err
		}
		if p.available, err = add(p.available, l.Amount.Amount()); err != nil {
			return Posted{}, err
		}
		id, err := uuid.NewV7()
		if err != nil {
			return Posted{}, fmt.Errorf("posting id: %w", err)
		}
		row, err := q.InsertPosting(ctx, ledgerdb.InsertPostingParams{
			ID: id, EntryID: entryID, AccountID: l.Account, AmountMinor: l.Amount.Amount(),
			Currency: p.row.Currency, BalanceAfterMinor: p.balance,
		})
		if err != nil {
			return Posted{}, fmt.Errorf("insert posting: %w", err)
		}
		postings = append(postings, row)
	}

	// Funds are judged on the entry's net effect, after any captured holds came back.
	for _, id := range sortedKeys(pos) {
		p := pos[id]
		if isDeposit(p.row.Kind) && p.available < 0 {
			return Posted{}, ErrInsufficientFunds
		}
	}
	if err := saveBalances(ctx, q, pos); err != nil {
		return Posted{}, err
	}
	return Posted{EntryID: entry.ID, CreatedAt: entry.CreatedAt, Postings: postings}, nil
}

// Hold describes money to set aside.
type Hold struct {
	Account uuid.UUID
	Amount  money.Money
	// Reference names what the hold is for: a transfer ID, a card authorisation.
	Reference string
	// Reason is a contract HoldReason ("pending_transfer", "card_authorization", ...).
	Reason string
	// ExpiresAt is when the hold lapses by itself; nil for none.
	ExpiresAt *time.Time
}

// PlaceHold sets the hold's amount aside: available drops, the ledger balance does not.
func PlaceHold(ctx context.Context, tx pgx.Tx, spec Hold) (ledgerdb.AccountHold, error) {
	account, amount := spec.Account, spec.Amount
	if !amount.IsPositive() {
		return ledgerdb.AccountHold{}, ErrBadHold
	}
	q := ledgerdb.New(tx)
	pos, err := lockAccounts(ctx, q, []uuid.UUID{account})
	if err != nil {
		return ledgerdb.AccountHold{}, err
	}
	p := pos[account]
	if p.row.Currency != string(amount.Currency()) {
		return ledgerdb.AccountHold{}, fmt.Errorf("%w: %s on account %s", ErrWrongCurrency, amount.Currency(), account)
	}
	if p.available < amount.Amount() {
		return ledgerdb.AccountHold{}, ErrInsufficientFunds
	}
	id, err := uuid.NewV7()
	if err != nil {
		return ledgerdb.AccountHold{}, fmt.Errorf("hold id: %w", err)
	}
	hold, err := q.InsertHold(ctx, ledgerdb.InsertHoldParams{
		ID: id, AccountID: account, Currency: p.row.Currency, AmountMinor: amount.Amount(), Reference: spec.Reference,
		Reason: spec.Reason, ExpiresAt: spec.ExpiresAt,
	})
	if err != nil {
		return ledgerdb.AccountHold{}, fmt.Errorf("insert hold: %w", err)
	}
	p.available -= amount.Amount() // cannot overflow: 0 < amount <= available
	if err := saveBalances(ctx, q, pos); err != nil {
		return ledgerdb.AccountHold{}, err
	}
	return hold, nil
}

// ReleaseHold ends an active hold without moving money: available comes back.
func ReleaseHold(ctx context.Context, tx pgx.Tx, holdID uuid.UUID) error {
	q := ledgerdb.New(tx)
	// Read without a lock to learn the account, then lock in the usual order (account,
	// then hold) and judge the hold only once it is locked.
	h, err := q.GetHold(ctx, holdID)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: hold %s", ErrHoldClosed, holdID)
	}
	if err != nil {
		return fmt.Errorf("load hold: %w", err)
	}
	pos, err := lockAccounts(ctx, q, []uuid.UUID{h.AccountID})
	if err != nil {
		return err
	}
	holds, err := q.LockHolds(ctx, []uuid.UUID{holdID})
	if err != nil {
		return fmt.Errorf("lock hold: %w", err)
	}
	if len(holds) != 1 || holds[0].Status != "active" {
		return fmt.Errorf("%w: hold %s", ErrHoldClosed, holdID)
	}
	if err := q.CloseHold(ctx, ledgerdb.CloseHoldParams{Status: "released", ID: holdID}); err != nil {
		return fmt.Errorf("release hold: %w", err)
	}
	pos[h.AccountID].available += holds[0].AmountMinor // back to at most the ledger balance
	return saveBalances(ctx, q, pos)
}

// GetBalances reads an account's cached balances. Read-only callers (the home screen)
// use it outside a transaction; a writer must lock through Post instead.
func GetBalances(ctx context.Context, db ledgerdb.DBTX, account uuid.UUID) (Balances, error) {
	a, err := ledgerdb.New(db).GetAccount(ctx, account)
	if errors.Is(err, pgx.ErrNoRows) {
		return Balances{}, fmt.Errorf("%w: %s", ErrUnknownAccount, account)
	}
	if err != nil {
		return Balances{}, fmt.Errorf("load account: %w", err)
	}
	c := money.Currency(a.Currency)
	return Balances{Ledger: money.New(a.BalanceMinor, c), Available: money.New(a.AvailableMinor, c), Version: a.Version}, nil
}

// ActiveHolds lists the account's active holds, newest first.
func ActiveHolds(ctx context.Context, db ledgerdb.DBTX, account uuid.UUID) ([]ledgerdb.AccountHold, error) {
	rows, err := ledgerdb.New(db).ListActiveHolds(ctx, account)
	if err != nil {
		return nil, fmt.Errorf("list holds: %w", err)
	}
	return rows, nil
}

// Drift lists accounts whose cached balances disagree with their postings and active
// holds. It is always empty while every write goes through the engine.
func Drift(ctx context.Context, db ledgerdb.DBTX) ([]ledgerdb.ListDriftRow, error) {
	rows, err := ledgerdb.New(db).ListDrift(ctx)
	if err != nil {
		return nil, fmt.Errorf("list drift: %w", err)
	}
	return rows, nil
}

// checkLegs refuses an entry that could never balance before any lock is taken.
func checkLegs(legs []Leg) error {
	if len(legs) < 2 {
		return ErrTooFewLegs
	}
	net := map[money.Currency]money.Money{}
	for _, l := range legs {
		c := l.Amount.Currency()
		if !c.Valid() {
			return fmt.Errorf("%w: %q", money.ErrUnknownCurrency, c)
		}
		if l.Amount.IsZero() {
			return ErrTooFewLegs
		}
		sum, ok := net[c]
		if !ok {
			sum = money.Zero(c)
		}
		var err error
		if net[c], err = sum.Add(l.Amount); err != nil {
			return fmt.Errorf("sum legs: %w", err)
		}
	}
	for c, m := range net {
		if !m.IsZero() {
			return fmt.Errorf("%w: %s nets to %d", ErrUnbalanced, c, m.Amount())
		}
	}
	return nil
}

func lockAccounts(ctx context.Context, q *ledgerdb.Queries, ids []uuid.UUID) (map[uuid.UUID]*position, error) {
	unique := slices.Clone(ids)
	slices.SortFunc(unique, compareIDs)
	unique = slices.Compact(unique)
	rows, err := q.LockAccounts(ctx, unique)
	if err != nil {
		return nil, fmt.Errorf("lock accounts: %w", err)
	}
	pos := make(map[uuid.UUID]*position, len(rows))
	for _, r := range rows {
		pos[r.ID] = &position{row: r, balance: r.BalanceMinor, available: r.AvailableMinor}
	}
	for _, id := range unique {
		if pos[id] == nil {
			return nil, fmt.Errorf("%w: %s", ErrUnknownAccount, id)
		}
	}
	return pos, nil
}

// captureHolds closes each hold as captured by entryID and returns its amount to
// available. A hold must sit on one of the entry's (already locked) accounts.
func captureHolds(ctx context.Context, q *ledgerdb.Queries, pos map[uuid.UUID]*position, ids []uuid.UUID, entryID uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	holds, err := q.LockHolds(ctx, ids)
	if err != nil {
		return fmt.Errorf("lock holds: %w", err)
	}
	if len(holds) != len(slices.Compact(slices.SortedFunc(slices.Values(ids), compareIDs))) {
		return fmt.Errorf("%w: a hold to capture does not exist", ErrHoldClosed)
	}
	for _, h := range holds {
		p := pos[h.AccountID]
		if p == nil {
			return fmt.Errorf("%w: hold %s is not on an account in this entry", ErrUnknownAccount, h.ID)
		}
		if h.Status != "active" {
			return fmt.Errorf("%w: hold %s", ErrHoldClosed, h.ID)
		}
		if err := q.CloseHold(ctx, ledgerdb.CloseHoldParams{Status: "captured", EntryID: &entryID, ID: h.ID}); err != nil {
			return fmt.Errorf("capture hold: %w", err)
		}
		p.available += h.AmountMinor // back to at most the ledger balance
	}
	return nil
}

func saveBalances(ctx context.Context, q *ledgerdb.Queries, pos map[uuid.UUID]*position) error {
	for _, id := range sortedKeys(pos) {
		p := pos[id]
		n, err := q.SetAccountBalances(ctx, ledgerdb.SetAccountBalancesParams{
			BalanceMinor: p.balance, AvailableMinor: p.available, ID: id, Version: p.row.Version,
		})
		if err != nil {
			return fmt.Errorf("update balances: %w", err)
		}
		if n != 1 {
			return fmt.Errorf("%w: %s", ErrStaleBalance, id)
		}
	}
	return nil
}

func metadataJSON(m map[string]any) ([]byte, error) {
	if m == nil {
		return []byte("{}"), nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("entry metadata: %w", err)
	}
	return b, nil
}

// add is checked int64 addition: a balance never wraps.
func add(a, b int64) (int64, error) {
	s := a + b
	if (b > 0 && s < a) || (b < 0 && s > a) {
		return 0, money.ErrOverflow
	}
	return s, nil
}

// isDeposit reports whether the account holds customer money that may not go below zero.
func isDeposit(kind string) bool {
	switch kind {
	case "customer_current", "customer_wallet", "customer_savings", "customer_locked":
		return true
	}
	return false
}

func compareIDs(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) }

func sortedKeys(pos map[uuid.UUID]*position) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(pos))
	for id := range pos {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, compareIDs)
	return ids
}
