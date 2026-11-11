package family

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/api"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/family/familydb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/ledgerdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

// lagos is Africa/Lagos (WAT, UTC+1, no daylight saving), the zone ages and allowance days are
// counted in. A fixed zone, so the distroless image needs no tzdata.
var lagos = time.FixedZone("WAT", 60*60)

var nemtagShape = regexp.MustCompile(`^[a-z][a-z0-9_]{2,19}$`)

// reservedNemtags mirror @nem/shared's RESERVED_NEMTAGS: names that would pass for the bank.
var reservedNemtags = []string{"nem", "nembank", "admin", "support", "help", "security", "official", "staff"}

// NewDependant is a dependant to add (contract CreateDependantRequest, checked for shape).
type NewDependant struct {
	FirstName, LastName string
	DateOfBirth         time.Time
	Nemtag              string
	Controls            api.DependantControls
}

// Controls are the parent's limits in minor units.
type controls struct {
	daily, threshold int64
	banks, paused    bool
}

func parseControls(c api.DependantControls) (controls, error) {
	daily, err := ngn(c.DailySpendLimit, "/controls/daily_spend_limit")
	if err != nil {
		return controls{}, err
	}
	threshold, err := ngn(c.ApprovalThreshold, "/controls/approval_threshold")
	if err != nil {
		return controls{}, err
	}
	return controls{daily: daily, threshold: threshold, banks: c.CanSendToBanks, paused: c.Paused}, nil
}

// ngn reads a positive naira amount; field names it in the error.
func ngn(m api.Money, field string) (int64, error) {
	v, err := money.ParseMinor(m.AmountMinor, string(m.Currency))
	if err != nil || v.Currency() != money.NGN || !v.IsPositive() {
		return 0, problem.Validation(problem.Field(field, "invalid", "Enter an amount above zero in naira."))
	}
	return v.Amount(), nil
}

func age(dob, now time.Time) int {
	n := now.In(lagos)
	y, m, d := dob.Date()
	years := n.Year() - y
	if n.Month() < m || (n.Month() == m && n.Day() < d) {
		years--
	}
	return years
}

func isUnique(err error, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == constraint
}

// CreateDependant adds a dependant (FAM-1): their user row, naira account and @nemtag, in one
// transaction, with a one-time setup code for the child's own device. The parent confirms with a
// step-up.
func (s *Service) CreateDependant(ctx context.Context, in NewDependant, stepUpToken string) (api.DependantCreated, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.DependantCreated{}, err
	}
	in.FirstName, in.LastName = strings.TrimSpace(in.FirstName), strings.TrimSpace(in.LastName)
	tag := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(in.Nemtag), "@"))
	now := s.now().UTC()
	var fields []api.FieldError
	if in.FirstName == "" {
		fields = append(fields, problem.Field("/first_name", "required", "Enter their first name."))
	}
	if in.LastName == "" {
		fields = append(fields, problem.Field("/last_name", "required", "Enter their last name."))
	}
	if !nemtagShape.MatchString(tag) {
		fields = append(fields, problem.Field("/nemtag", "invalid", "Use 3 to 20 letters, numbers or underscores, starting with a letter."))
	} else if slices.Contains(reservedNemtags, tag) {
		fields = append(fields, problem.Field("/nemtag", "reserved", "This one is reserved. Try another."))
	}
	if len(fields) > 0 {
		return api.DependantCreated{}, problem.Validation(fields...)
	}
	if a := age(in.DateOfBirth, now); a < MinAge || a > MaxAge {
		return api.DependantCreated{}, errAge
	}
	c, err := parseControls(in.Controls)
	if err != nil {
		return api.DependantCreated{}, err
	}
	code, err := newSetupCode()
	if err != nil {
		return api.DependantCreated{}, err
	}
	userID, err := uuid.NewV7()
	if err != nil {
		return api.DependantCreated{}, fmt.Errorf("user id: %w", err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return api.DependantCreated{}, fmt.Errorf("dependant id: %w", err)
	}
	expires := now.Add(SetupCodeTTL)

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if s.stepUps == nil {
			return identity.ErrStepUpRequired
		}
		if err := s.stepUps.ConsumeStepUp(ctx, tx, p.UserID, StepUpPurpose, stepUpToken); err != nil {
			return err
		}
		q := s.q.WithTx(tx)
		// The parent's own row is the lock that serialises the cap. A dependant has no
		// dependants, so for them there is no row to lock and the answer is no.
		if _, err := q.LockGuardian(ctx, p.UserID); errors.Is(err, pgx.ErrNoRows) {
			return problem.Forbidden()
		} else if err != nil {
			return fmt.Errorf("lock guardian: %w", err)
		}
		n, err := q.CountDependants(ctx, p.UserID)
		if err != nil {
			return fmt.Errorf("count dependants: %w", err)
		}
		if n >= MaxDependants {
			return errTooMany
		}
		if _, err := q.InsertDependantUser(ctx, familydb.InsertDependantUserParams{
			ID: userID, FirstName: in.FirstName, LastName: in.LastName, DateOfBirth: pgtype.Date{Time: in.DateOfBirth, Valid: true}, Nemtag: &tag, GuardianID: p.UserID,
		}); err != nil {
			if isUnique(err, "users_nemtag_key") {
				return problem.New(409, "nemtag_taken", "@"+tag+" is taken").WithDetail("Pick another @nemtag.")
			}
			return fmt.Errorf("insert dependant user: %w", err)
		}
		if err := accounts.OpenCurrentAccount(ctx, tx, identity.NewCustomer{UserID: userID, Name: in.FirstName + " " + in.LastName}); err != nil {
			return err
		}
		acct, err := q.GetNairaAccount(ctx, userID)
		if err != nil {
			return fmt.Errorf("load dependant account: %w", err)
		}
		if err := q.InsertDependant(ctx, familydb.InsertDependantParams{
			ID: id, GuardianID: p.UserID, UserID: userID, AccountID: acct.AccountID, DailySpendLimitMinor: c.daily,
			ApprovalThresholdMinor: c.threshold, CanSendToBanks: c.banks, SetupCodeHash: s.codeHash(id, code),
			SetupCodeExpiresAt: &expires, CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("insert dependant: %w", err)
		}
		return nil
	})
	if err != nil {
		return api.DependantCreated{}, err
	}
	row, err := s.q.GetDependant(ctx, familydb.GetDependantParams{ID: id, GuardianID: p.UserID})
	if err != nil {
		return api.DependantCreated{}, fmt.Errorf("reload dependant: %w", err)
	}
	d, err := s.dependantJSON(ctx, s.pool, depRow(row))
	if err != nil {
		return api.DependantCreated{}, err
	}
	return api.DependantCreated{Dependant: d, SetupCode: code, SetupCodeExpiresAt: expires}, nil
}

// depRow is a dependant joined with their user row.
type depRow familydb.GetDependantRow

func (s *Service) dependantJSON(ctx context.Context, db ledgerdb.DBTX, r depRow) (api.Dependant, error) {
	bal, err := ledger.GetBalances(ctx, db, r.AccountID)
	if err != nil {
		return api.Dependant{}, fmt.Errorf("dependant balance: %w", err)
	}
	out := api.Dependant{
		Id: r.ID, AccountId: r.AccountID, Balance: accounts.Money(bal.Ledger), KidMode: r.KidMode,
		DateOfBirth: api.Date{Time: r.DateOfBirth.Time}, CreatedAt: r.CreatedAt.UTC(),
		Profile: api.PartySummary{Name: r.FirstName + " " + r.LastName, Nemtag: r.Nemtag, UserId: r.UserID},
		Controls: api.DependantControls{
			DailySpendLimit:   accounts.Money(money.New(r.DailySpendLimitMinor, money.NGN)),
			ApprovalThreshold: accounts.Money(money.New(r.ApprovalThresholdMinor, money.NGN)),
			CanSendToBanks:    r.CanSendToBanks, Paused: r.Paused,
		},
	}
	if r.AllowanceAmountMinor != nil && r.AllowanceFrequency != nil && r.AllowanceSourceAccountID != nil {
		day := int(r.AllowanceDay.Int16)
		a := api.Allowance{
			Amount: accounts.Money(money.New(*r.AllowanceAmountMinor, money.NGN)), Frequency: api.AllowanceFrequency(*r.AllowanceFrequency),
			Day: &day, SourceAccountId: *r.AllowanceSourceAccountID,
		}
		if r.AllowanceNextRunAt != nil {
			t := r.AllowanceNextRunAt.UTC()
			a.NextRunAt = &t
		}
		out.Allowance = &a
	}
	return out, nil
}

// Dependants lists the caller's dependants with their balances.
func (s *Service) Dependants(ctx context.Context) ([]api.Dependant, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListDependants(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list dependants: %w", err)
	}
	out := make([]api.Dependant, 0, len(rows))
	for _, r := range rows {
		d, err := s.dependantJSON(ctx, s.pool, depRow(r))
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

// Dependant returns one of the caller's dependants.
func (s *Service) Dependant(ctx context.Context, id uuid.UUID) (api.Dependant, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Dependant{}, err
	}
	return s.dependant(ctx, p.UserID, id)
}

func (s *Service) dependant(ctx context.Context, guardian, id uuid.UUID) (api.Dependant, error) {
	r, err := s.q.GetDependant(ctx, familydb.GetDependantParams{ID: id, GuardianID: guardian})
	if errors.Is(err, pgx.ErrNoRows) {
		return api.Dependant{}, errDependantNotFound
	}
	if err != nil {
		return api.Dependant{}, fmt.Errorf("load dependant: %w", err)
	}
	return s.dependantJSON(ctx, s.pool, depRow(r))
}

// UpdateControls changes kid mode and the parent's controls (FAM-2): the spend limit, the
// approval threshold, whether the dependant may pay other banks, and the pause. They apply to
// the next transfer; money already set aside for approval is not touched.
func (s *Service) UpdateControls(ctx context.Context, id uuid.UUID, req api.UpdateDependantRequest) (api.Dependant, error) {
	p, err := principal(ctx)
	if err != nil {
		return api.Dependant{}, err
	}
	arg := familydb.UpdateControlsParams{ID: id}
	if req.KidMode != nil {
		arg.KidMode = pgtype.Bool{Bool: *req.KidMode, Valid: true}
	}
	if req.Controls != nil {
		c, err := parseControls(*req.Controls)
		if err != nil {
			return api.Dependant{}, err
		}
		arg.DailySpendLimitMinor, arg.ApprovalThresholdMinor = &c.daily, &c.threshold
		arg.CanSendToBanks = pgtype.Bool{Bool: c.banks, Valid: true}
		arg.Paused = pgtype.Bool{Bool: c.paused, Valid: true}
	}
	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := q.GetDependantForUpdate(ctx, familydb.GetDependantForUpdateParams{ID: id, GuardianID: p.UserID}); errors.Is(err, pgx.ErrNoRows) {
			return errDependantNotFound
		} else if err != nil {
			return fmt.Errorf("lock dependant: %w", err)
		}
		return q.UpdateControls(ctx, arg)
	})
	if err != nil {
		return api.Dependant{}, err
	}
	return s.dependant(ctx, p.UserID, id)
}

// Activity is a dependant's transactions, newest first, read-only for the parent (FAM-3).
func (s *Service) Activity(ctx context.Context, id uuid.UUID, cursor *string, limit *int) ([]api.Transaction, api.PageInfo, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	d, err := s.q.GetDependant(ctx, familydb.GetDependantParams{ID: id, GuardianID: p.UserID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, api.PageInfo{}, errDependantNotFound
	}
	if err != nil {
		return nil, api.PageInfo{}, fmt.Errorf("load dependant: %w", err)
	}
	rows, page, err := s.accounts.TransactionsFor(ctx, d.UserID, accounts.Filter{Cursor: cursor, Limit: limit})
	if err != nil {
		return nil, api.PageInfo{}, err
	}
	out := make([]api.Transaction, 0, len(rows))
	for _, r := range rows {
		t, err := accounts.TransactionJSON(r)
		if err != nil {
			return nil, api.PageInfo{}, err
		}
		out = append(out, t)
	}
	return out, page, nil
}
