package privacy

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/privacy/privacydb"
)

// DemoRetention is how long a demo customer lives before the nightly clean-up retires them. It
// is long enough for a recruiter to try the demo over a day and a bit.
const DemoRetention = 24 * time.Hour

// demoPurgeBatch bounds one housekeeping pass; the rest go on the next hour's pass.
const demoPurgeBatch = 50

// PurgeDemo retires demo customers older than DemoRetention (the contract says demo users are
// reset nightly). The ledger is append-only, so a demo customer is not deleted: whatever money
// they hold goes back to the bank's demo funding account, then they are erased exactly like a
// customer who closed their account, which leaves a row that identifies nobody. A demo customer
// the bank's rules would not let close (an open loan, an ajo group) is left for the next pass.
func (s *Service) PurgeDemo(ctx context.Context) error {
	rows, err := s.pool.Query(ctx, `
		SELECT id FROM users
		WHERE is_demo AND deleted_at IS NULL AND created_at < $1
		ORDER BY created_at LIMIT $2`, s.now().Add(-DemoRetention), demoPurgeBatch)
	if err != nil {
		return fmt.Errorf("list old demo customers: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return fmt.Errorf("read old demo customers: %w", err)
	}
	for _, id := range ids {
		if err := s.purgeOneDemo(ctx, id); err != nil {
			s.log.WarnContext(ctx, "demo clean-up skipped a customer", slog.String("user_id", id.String()), slog.Any("error", err))
		}
	}
	return nil
}

func (s *Service) purgeOneDemo(ctx context.Context, uid uuid.UUID) error {
	now := s.now().UTC()
	return s.inTx(ctx, func(tx pgx.Tx, q *privacydb.Queries) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 AND is_demo FOR UPDATE`, uid); err != nil {
			return fmt.Errorf("lock demo customer: %w", err)
		}
		if err := returnDemoMoney(ctx, tx, uid); err != nil {
			return err
		}
		b, err := q.DeletionBlockers(ctx, uid)
		if err != nil {
			return fmt.Errorf("check eligibility: %w", err)
		}
		if why := blockers(b); len(why) > 0 {
			return fmt.Errorf("cannot retire yet: %s", strings.Join(why, " "))
		}
		if err := eraseCustomer(ctx, q, uid, now); err != nil {
			return err
		}
		_, err = audit.Append(ctx, tx, audit.Input{
			Actor: audit.System(), Action: "demo.purge", ResourceType: "customer", ResourceID: uid.String(),
		}, now)
		return err
	})
}

// returnDemoMoney sends every positive balance a demo customer owns back to the demo funding
// account it came from. A balance with a hold on it is left, which keeps the customer from
// closing until the hold is gone.
func returnDemoMoney(ctx context.Context, tx pgx.Tx, uid uuid.UUID) error {
	rows, err := tx.Query(ctx, `
		SELECT id, currency, balance_minor FROM ledger_accounts
		WHERE owner_id = $1 AND balance_minor > 0 AND available_minor = balance_minor`, uid)
	if err != nil {
		return fmt.Errorf("list demo balances: %w", err)
	}
	type held struct {
		id       uuid.UUID
		currency string
		minor    int64
	}
	owned, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (held, error) {
		var h held
		return h, r.Scan(&h.id, &h.currency, &h.minor)
	})
	if err != nil {
		return fmt.Errorf("read demo balances: %w", err)
	}
	for _, h := range owned {
		src, err := ledger.SystemAccount(ctx, tx, ledger.KindDemoFunding, h.currency)
		if err != nil {
			return err
		}
		amt := money.New(h.minor, money.Currency(h.currency))
		if _, err := ledger.Post(ctx, tx, ledger.Entry{
			Kind: "demo_funding", Reference: "DEMO-RETURN-" + strings.ToUpper(strings.ReplaceAll(uuid.NewString(), "-", "")[:12]),
			Legs: []ledger.Leg{ledger.Debit(h.id, amt), ledger.Credit(src.ID, amt)},
		}); err != nil {
			return fmt.Errorf("return demo money: %w", err)
		}
	}
	return nil
}
