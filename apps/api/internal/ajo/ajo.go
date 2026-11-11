// Package ajo implements Digital Ajo group savings (FR-AJO, T28.4): groups, membership,
// schedule, auto-debit contributions, payouts and default handling.
//
// Each group holds its money in a dedicated ledger escrow account (kind ajo_escrow), so
// the pot balance is always the ledger's balance and only ledger postings can move it.
package ajo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts/accountsdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ajo/ajodb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/ledger/money"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
)

const (
	maxMemberCount = 30
	minMemberCount = 2
	inviteTTLDays  = 7
)

var lagos = time.FixedZone("WAT", 60*60)

var (
	ErrGroupNotFound  = problem.NotFound("Ajo group")
	ErrInviteNotFound = problem.New(http.StatusNotFound, "not_found", "This invite link is not valid")
	errNaira          = problem.New(http.StatusUnprocessableEntity, problem.CodeValidationFailed, "Ajo is saved in naira")
	errNotActive      = problem.New(http.StatusForbidden, "account_not_active", "This account cannot be used right now")
	errAlreadyStarted = problem.New(http.StatusConflict, "invalid_state", "This ajo has already started")
	errGroupFull      = problem.New(http.StatusConflict, "group_full", "This ajo is full")
	errAlreadyMember  = problem.New(http.StatusConflict, "already_member", "You are already in this ajo")
	errNotOrganiser   = problem.New(http.StatusForbidden, "forbidden", "Only the organiser can start the ajo")
	errDebt           = problem.New(http.StatusConflict, "ajo_debt", "Pay what you owe first").
				WithDetail("You had your payout in another ajo but missed a contribution after it.")
)

type Accounts interface {
	Owned(ctx context.Context, userID, accountID uuid.UUID) (accountsdb.GetCustomerAccountRow, error)
	Naira(ctx context.Context, userID uuid.UUID) (accountsdb.CustomerAccount, error)
}

type Customers interface {
	CustomerProfile(ctx context.Context, userID uuid.UUID) (identity.CustomerProfile, error)
	FindCustomer(ctx context.Context, handle string) (uuid.UUID, error)
}

type Config struct {
	Pool       *pgxpool.Pool
	Accounts   Accounts
	Customers  Customers
	Logger     *slog.Logger
	Now        func() time.Time
	WebBaseURL string
}

type Service struct {
	pool       *pgxpool.Pool
	q          *ajodb.Queries
	accounts   Accounts
	customers  Customers
	log        *slog.Logger
	now        func() time.Time
	webBaseURL string
}

func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Accounts == nil || cfg.Customers == nil || cfg.Logger == nil {
		return nil, errors.New("ajo: pool, accounts, customers and logger are required")
	}
	s := &Service{
		pool:       cfg.Pool,
		q:          ajodb.New(cfg.Pool),
		accounts:   cfg.Accounts,
		customers:  cfg.Customers,
		log:        cfg.Logger.With("component", "ajo"),
		now:        cfg.Now,
		webBaseURL: strings.TrimRight(cfg.WebBaseURL, "/"),
	}
	if s.now == nil {
		s.now = time.Now
	}
	if s.webBaseURL == "" {
		s.webBaseURL = "https://nem-bank-fodx.vercel.app"
	}
	return s, nil
}

func principal(ctx context.Context) (identity.Principal, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return identity.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

func reference(prefix string, id uuid.UUID) string {
	return prefix + "-" + strings.ToUpper(strings.ReplaceAll(id.String(), "-", "")[20:])
}

func lagosDay(t time.Time) time.Time {
	in := t.In(lagos)
	return time.Date(in.Year(), in.Month(), in.Day(), 0, 0, 0, 0, time.UTC)
}

func cycleDays(frequency string) int {
	switch frequency {
	case "daily":
		return 1
	case "weekly":
		return 7
	case "monthly":
		return 30
	default:
		return 7
	}
}

type CreateGroupInput struct {
	Name             string
	Contribution     money.Money
	Frequency        string
	MemberCount      int
	Rotation         string
	StartDate        time.Time
	GracePeriodHours int
	SourceAccountID  uuid.UUID
}

type MemberView struct {
	User                identity.CustomerProfile
	UserID              uuid.UUID
	Position            *int
	Status              string
	HasReceivedPayout   bool
	ContributionsPaid   int
	MissedContributions int
}

type GroupView struct {
	ID                 uuid.UUID
	Name               string
	AccountID          uuid.UUID
	CreatedByID        uuid.UUID
	CreatedBy          identity.CustomerProfile
	Contribution       money.Money
	Frequency          string
	MemberCount        int
	Rotation           string
	StartDate          time.Time
	GracePeriodHours   int
	Status             string
	CurrentCycle       int
	TotalCycles        int
	PotBalance         money.Money
	InviteCode         string
	InviteURL          string
	InviteExpiresAt    time.Time
	CreatedAt          time.Time
	StartedAt          *time.Time
	EndedAt            *time.Time
	Members            []MemberView
	NextContributionAt *time.Time
	NextPayout         *NextPayoutView
}

type NextPayoutView struct {
	Member identity.CustomerProfile
	UserID uuid.UUID
	Amount money.Money
	At     time.Time
}

type CycleView struct {
	ID            uuid.UUID
	GroupID       uuid.UUID
	CycleNumber   int
	DueAt         time.Time
	PayoutToUser  identity.CustomerProfile
	PayoutToID    uuid.UUID
	PayoutAmount  money.Money
	PayoutStatus  string
	Contributions []ContributionView
}

type ContributionView struct {
	User     identity.CustomerProfile
	UserID   uuid.UUID
	Status   string
	Attempts int
	PaidAt   *time.Time
}

type InviteResult struct {
	InviteCode string
	InviteURL  string
	ExpiresAt  time.Time
	Invited    []identity.CustomerProfile
	InvitedIDs []uuid.UUID
}

func (s *Service) assertNoDebt(ctx context.Context, userID uuid.UUID) error {
	hasDebt, err := s.q.CheckAjoDebt(ctx, userID)
	if err != nil {
		return fmt.Errorf("check ajo debt: %w", err)
	}
	if hasDebt {
		return errDebt
	}
	return nil
}

func (s *Service) Create(ctx context.Context, in CreateGroupInput) (GroupView, error) {
	p, err := principal(ctx)
	if err != nil {
		return GroupView{}, err
	}
	if err := s.assertNoDebt(ctx, p.UserID); err != nil {
		return GroupView{}, err
	}

	name := strings.TrimSpace(in.Name)
	if n := utf8.RuneCountInString(name); n < 1 || n > 40 {
		return GroupView{}, problem.Validation(problem.Field("/name", "length", "Give your ajo a name of up to 40 characters."))
	}
	if in.Contribution.Currency() != money.NGN || !in.Contribution.IsPositive() {
		return GroupView{}, problem.Validation(problem.Field("/contribution", "invalid", "Enter a positive contribution in naira."))
	}
	switch in.Frequency {
	case "daily", "weekly", "monthly":
	default:
		return GroupView{}, problem.Validation(problem.Field("/frequency", "invalid", "Pick daily, weekly or monthly."))
	}
	if in.MemberCount < minMemberCount || in.MemberCount > maxMemberCount {
		return GroupView{}, problem.Validation(problem.Field("/member_count", "range", fmt.Sprintf("Member count must be between %d and %d.", minMemberCount, maxMemberCount)))
	}
	switch in.Rotation {
	case "fixed", "random_draw":
	default:
		return GroupView{}, problem.Validation(problem.Field("/rotation", "invalid", "Pick fixed or random_draw."))
	}
	now := s.now().UTC()
	startDay := lagosDay(in.StartDate)
	todayDay := lagosDay(now)
	if startDay.Before(todayDay) {
		return GroupView{}, problem.Validation(problem.Field("/start_date", "past", "Pick a start date from today."))
	}
	if in.GracePeriodHours < 0 || in.GracePeriodHours > 72 {
		return GroupView{}, problem.Validation(problem.Field("/grace_period_hours", "range", "Grace period must be between 0 and 72 hours."))
	}

	src, err := s.accounts.Owned(ctx, p.UserID, in.SourceAccountID)
	if err != nil {
		return GroupView{}, err
	}
	if src.Status != "active" {
		return GroupView{}, errNotActive
	}
	if src.Currency != string(money.NGN) {
		return GroupView{}, errNaira
	}

	groupID, err := uuid.NewV7()
	if err != nil {
		return GroupView{}, fmt.Errorf("group id: %w", err)
	}
	inviteCode := strings.ToUpper(strings.ReplaceAll(groupID.String(), "-", "")[26:])
	expiresAt := now.AddDate(0, 0, inviteTTLDays)

	var position pgtype.Int4
	if in.Rotation == "fixed" {
		position = pgtype.Int4{Int32: 1, Valid: true}
	}

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		escrowAccountID, err := ledger.OpenEscrowAccount(ctx, tx, ledger.KindAjoEscrow, string(money.NGN), "Ajo: "+name)
		if err != nil {
			return err
		}
		q := s.q.WithTx(tx)
		_, err = q.InsertAjoGroup(ctx, ajodb.InsertAjoGroupParams{
			ID:                 groupID,
			Name:               name,
			AccountID:          escrowAccountID,
			CreatedByID:        p.UserID,
			ContributionMinor:  in.Contribution.Amount(),
			Frequency:          in.Frequency,
			MemberCount:        int32(in.MemberCount),
			Rotation:           in.Rotation,
			StartDate:          startDay,
			GracePeriodHours:   int32(in.GracePeriodHours),
			Status:             "forming",
			CurrentCycle:       0,
			TotalCycles:        int32(in.MemberCount),
			InviteCode:         inviteCode,
			InviteExpiresAt:    expiresAt,
			CreatedAt:          now,
		})
		if err != nil {
			return fmt.Errorf("insert ajo group: %w", err)
		}
		return q.InsertAjoMember(ctx, ajodb.InsertAjoMemberParams{
			GroupID:             groupID,
			UserID:              p.UserID,
			SourceAccountID:     in.SourceAccountID,
			Position:            position,
			Status:              "joined",
			HasReceivedPayout:   false,
			ContributionsPaid:   0,
			MissedContributions: 0,
			JoinedAt:            now,
		})
	})
	if err != nil {
		return GroupView{}, err
	}
	return s.Get(ctx, groupID)
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (GroupView, error) {
	row, err := s.q.GetAjoGroup(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return GroupView{}, ErrGroupNotFound
	}
	if err != nil {
		return GroupView{}, fmt.Errorf("load ajo group: %w", err)
	}
	return s.assembleGroup(ctx, row)
}

func (s *Service) List(ctx context.Context) ([]GroupView, error) {
	p, err := principal(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListAjoGroupsForUser(ctx, p.UserID)
	if err != nil {
		return nil, fmt.Errorf("list ajo groups: %w", err)
	}
	out := make([]GroupView, 0, len(rows))
	for _, r := range rows {
		gv, err := s.assembleGroup(ctx, ajodb.GetAjoGroupRow(r))
		if err != nil {
			return nil, err
		}
		out = append(out, gv)
	}
	return out, nil
}

func (s *Service) assembleGroup(ctx context.Context, g ajodb.GetAjoGroupRow) (GroupView, error) {
	creatorProfile, err := s.customers.CustomerProfile(ctx, g.CreatedByID)
	if err != nil {
		return GroupView{}, fmt.Errorf("load creator profile: %w", err)
	}

	members, err := s.q.ListAjoMembers(ctx, g.ID)
	if err != nil {
		return GroupView{}, fmt.Errorf("list members: %w", err)
	}

	memberViews := make([]MemberView, len(members))
	for i, m := range members {
		prof, err := s.customers.CustomerProfile(ctx, m.UserID)
		if err != nil {
			return GroupView{}, fmt.Errorf("load member profile: %w", err)
		}
		var pos *int
		if m.Position.Valid {
			pVal := int(m.Position.Int32)
			pos = &pVal
		}
		memberViews[i] = MemberView{
			User:                prof,
			UserID:              m.UserID,
			Position:            pos,
			Status:              m.Status,
			HasReceivedPayout:   m.HasReceivedPayout,
			ContributionsPaid:   int(m.ContributionsPaid),
			MissedContributions: int(m.MissedContributions),
		}
	}

	gv := GroupView{
		ID:               g.ID,
		Name:             g.Name,
		AccountID:        g.AccountID,
		CreatedByID:      g.CreatedByID,
		CreatedBy:        creatorProfile,
		Contribution:     money.New(g.ContributionMinor, money.NGN),
		Frequency:        g.Frequency,
		MemberCount:      int(g.MemberCount),
		Rotation:         g.Rotation,
		StartDate:        g.StartDate,
		GracePeriodHours: int(g.GracePeriodHours),
		Status:           g.Status,
		CurrentCycle:     int(g.CurrentCycle),
		TotalCycles:      int(g.TotalCycles),
		PotBalance:       money.New(g.PotBalanceMinor, money.NGN),
		InviteCode:       g.InviteCode,
		InviteURL:        fmt.Sprintf("%s/ajo/%s", s.webBaseURL, g.InviteCode),
		InviteExpiresAt:  g.InviteExpiresAt,
		CreatedAt:        g.CreatedAt,
		StartedAt:        g.StartedAt,
		EndedAt:          g.EndedAt,
		Members:          memberViews,
	}

	if g.Status == "active" && g.CurrentCycle > 0 && g.CurrentCycle <= g.TotalCycles {
		cycle, err := s.q.GetAjoCycle(ctx, ajodb.GetAjoCycleParams{GroupID: g.ID, CycleNumber: g.CurrentCycle})
		if err == nil {
			gv.NextContributionAt = &cycle.DueAt
			payeeProf, err := s.customers.CustomerProfile(ctx, cycle.PayoutToUserID)
			if err == nil {
				gv.NextPayout = &NextPayoutView{
					Member: payeeProf,
					UserID: cycle.PayoutToUserID,
					Amount: money.New(cycle.PayoutAmountMinor, money.NGN),
					At:     cycle.DueAt,
				}
			}
		}
	} else if g.Status == "forming" {
		due := time.Date(g.StartDate.Year(), g.StartDate.Month(), g.StartDate.Day(), 9, 0, 0, 0, lagos).UTC()
		gv.NextContributionAt = &due
	}

	return gv, nil
}

func (s *Service) Invite(ctx context.Context, groupID uuid.UUID, nemtags []string) (InviteResult, error) {
	p, err := principal(ctx)
	if err != nil {
		return InviteResult{}, err
	}
	g, err := s.q.GetAjoGroup(ctx, groupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return InviteResult{}, ErrGroupNotFound
	}
	if err != nil {
		return InviteResult{}, fmt.Errorf("load ajo group: %w", err)
	}
	if g.Status != "forming" {
		return InviteResult{}, errAlreadyStarted
	}
	if g.CreatedByID != p.UserID {
		if _, err := s.q.GetAjoMember(ctx, ajodb.GetAjoMemberParams{GroupID: groupID, UserID: p.UserID}); err != nil {
			return InviteResult{}, problem.New(http.StatusForbidden, "forbidden", "Only members can invite to this ajo")
		}
	}

	members, err := s.q.ListAjoMembers(ctx, groupID)
	if err != nil {
		return InviteResult{}, fmt.Errorf("list members: %w", err)
	}

	var invited []identity.CustomerProfile
	var invitedIDs []uuid.UUID

	for _, tag := range nemtags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		targetUserID, err := s.customers.FindCustomer(ctx, tag)
		if err != nil {
			return InviteResult{}, problem.New(http.StatusNotFound, "not_found", fmt.Sprintf("No Nem user is @%s", strings.TrimPrefix(tag, "@")))
		}

		already := false
		for _, m := range members {
			if m.UserID == targetUserID {
				already = true
				break
			}
		}
		if already {
			continue
		}
		if len(members)+len(invitedIDs) >= int(g.MemberCount) {
			return InviteResult{}, errGroupFull
		}

		targetProf, err := s.customers.CustomerProfile(ctx, targetUserID)
		if err != nil {
			return InviteResult{}, fmt.Errorf("load invited profile: %w", err)
		}
		invited = append(invited, targetProf)
		invitedIDs = append(invitedIDs, targetUserID)

		// Auto-join demo friends if they have a naira account so group can be tested
		targetAcc, err := s.accounts.Naira(ctx, targetUserID)
		if err == nil {
			now := s.now().UTC()
			var pos pgtype.Int4
			if g.Rotation == "fixed" {
				pos = pgtype.Int4{Int32: int32(len(members) + len(invitedIDs)), Valid: true}
			}
			_ = s.q.InsertAjoMember(ctx, ajodb.InsertAjoMemberParams{
				GroupID:             groupID,
				UserID:              targetUserID,
				SourceAccountID:     targetAcc.AccountID,
				Position:            pos,
				Status:              "joined",
				HasReceivedPayout:   false,
				ContributionsPaid:   0,
				MissedContributions: 0,
				JoinedAt:            now,
			})
		}
	}

	expiresAt := s.now().UTC().AddDate(0, 0, inviteTTLDays)
	return InviteResult{
		InviteCode: g.InviteCode,
		InviteURL:  fmt.Sprintf("%s/ajo/%s", s.webBaseURL, g.InviteCode),
		ExpiresAt:  expiresAt,
		Invited:    invited,
		InvitedIDs: invitedIDs,
	}, nil
}

func (s *Service) GetInvite(ctx context.Context, inviteCode string) (GroupView, error) {
	row, err := s.q.GetAjoGroupByInviteCode(ctx, strings.ToUpper(inviteCode))
	if errors.Is(err, pgx.ErrNoRows) {
		return GroupView{}, ErrInviteNotFound
	}
	if err != nil {
		return GroupView{}, fmt.Errorf("load invite: %w", err)
	}
	return s.assembleGroup(ctx, ajodb.GetAjoGroupRow(row))
}

func (s *Service) AcceptInvite(ctx context.Context, inviteCode string, sourceAccountID uuid.UUID) (GroupView, error) {
	p, err := principal(ctx)
	if err != nil {
		return GroupView{}, err
	}
	if err := s.assertNoDebt(ctx, p.UserID); err != nil {
		return GroupView{}, err
	}

	src, err := s.accounts.Owned(ctx, p.UserID, sourceAccountID)
	if err != nil {
		return GroupView{}, err
	}
	if src.Status != "active" {
		return GroupView{}, errNotActive
	}
	if src.Currency != string(money.NGN) {
		return GroupView{}, errNaira
	}

	row, err := s.q.GetAjoGroupByInviteCode(ctx, strings.ToUpper(inviteCode))
	if errors.Is(err, pgx.ErrNoRows) {
		return GroupView{}, ErrInviteNotFound
	}
	if err != nil {
		return GroupView{}, fmt.Errorf("load invite: %w", err)
	}
	if row.Status != "forming" {
		return GroupView{}, errAlreadyStarted
	}

	members, err := s.q.ListAjoMembers(ctx, row.ID)
	if err != nil {
		return GroupView{}, fmt.Errorf("list members: %w", err)
	}
	for _, m := range members {
		if m.UserID == p.UserID && m.Status != "left" {
			return GroupView{}, errAlreadyMember
		}
	}
	joinedCount := 0
	for _, m := range members {
		if m.Status == "joined" {
			joinedCount++
		}
	}
	if joinedCount >= int(row.MemberCount) {
		return GroupView{}, errGroupFull
	}

	now := s.now().UTC()
	var pos pgtype.Int4
	if row.Rotation == "fixed" {
		pos = pgtype.Int4{Int32: int32(joinedCount + 1), Valid: true}
	}

	err = s.q.InsertAjoMember(ctx, ajodb.InsertAjoMemberParams{
		GroupID:             row.ID,
		UserID:              p.UserID,
		SourceAccountID:     sourceAccountID,
		Position:            pos,
		Status:              "joined",
		HasReceivedPayout:   false,
		ContributionsPaid:   0,
		MissedContributions: 0,
		JoinedAt:            now,
	})
	if err != nil {
		return GroupView{}, fmt.Errorf("join ajo group: %w", err)
	}
	return s.Get(ctx, row.ID)
}

func (s *Service) Start(ctx context.Context, groupID uuid.UUID) (GroupView, error) {
	p, err := principal(ctx)
	if err != nil {
		return GroupView{}, err
	}
	g, err := s.q.GetAjoGroup(ctx, groupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return GroupView{}, ErrGroupNotFound
	}
	if err != nil {
		return GroupView{}, fmt.Errorf("load ajo group: %w", err)
	}
	if g.CreatedByID != p.UserID {
		return GroupView{}, errNotOrganiser
	}
	if g.Status != "forming" {
		return GroupView{}, errAlreadyStarted
	}

	members, err := s.q.ListAjoMembers(ctx, groupID)
	if err != nil {
		return GroupView{}, fmt.Errorf("list members: %w", err)
	}
	var joined []ajodb.AjoMember
	for _, m := range members {
		if m.Status == "joined" {
			joined = append(joined, m)
		}
	}
	if len(joined) != int(g.MemberCount) {
		return GroupView{}, problem.New(http.StatusConflict, "invalid_state",
			fmt.Sprintf("Waiting for %d more member(s)", int(g.MemberCount)-len(joined)))
	}

	order := make([]ajodb.AjoMember, len(joined))
	copy(order, joined)
	if g.Rotation == "random_draw" {
		rand.Shuffle(len(order), func(i, j int) {
			order[i], order[j] = order[j], order[i]
		})
	}

	now := s.now().UTC()
	potMinor := g.ContributionMinor * int64(g.MemberCount)
	step := cycleDays(g.Frequency)

	err = pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		for i, m := range order {
			order[i].Position = pgtype.Int4{Int32: int32(i + 1), Valid: true}
			if err := q.UpdateAjoMemberPosition(ctx, ajodb.UpdateAjoMemberPositionParams{
				GroupID:  groupID,
				UserID:   m.UserID,
				Position: pgtype.Int4{Int32: int32(i + 1), Valid: true},
			}); err != nil {
				return fmt.Errorf("update member position: %w", err)
			}
		}

		for i, m := range order {
			cycleID, err := uuid.NewV7()
			if err != nil {
				return err
			}
			dueAt := now.AddDate(0, 0, step*(i+1))
			payoutStatus := "upcoming"
			if i == 0 {
				payoutStatus = "collecting"
			}
			err = q.InsertAjoCycle(ctx, ajodb.InsertAjoCycleParams{
				ID:                cycleID,
				GroupID:           groupID,
				CycleNumber:       int32(i + 1),
				DueAt:             dueAt,
				PayoutToUserID:    m.UserID,
				PayoutAmountMinor: potMinor,
				PayoutStatus:      payoutStatus,
				CreatedAt:         now,
			})
			if err != nil {
				return fmt.Errorf("insert cycle: %w", err)
			}

			for _, contribMember := range order {
				err = q.InsertAjoContribution(ctx, ajodb.InsertAjoContributionParams{
					CycleID:  cycleID,
					UserID:   contribMember.UserID,
					Status:   "pending",
					Attempts: 0,
					PaidAt:   nil,
					EntryID:  nil,
				})
				if err != nil {
					return fmt.Errorf("insert contribution: %w", err)
				}
			}
		}

		startedAt := now
		return q.UpdateAjoGroupStatus(ctx, ajodb.UpdateAjoGroupStatusParams{
			ID:        groupID,
			Status:    "active",
			StartedAt: &startedAt,
			EndedAt:   nil,
		})
	})
	if err != nil {
		return GroupView{}, err
	}

	_ = s.q.UpdateAjoGroupCurrentCycle(ctx, ajodb.UpdateAjoGroupCurrentCycleParams{
		ID:           groupID,
		CurrentCycle: 1,
	})

	// Collect first cycle immediately (AJO-3)
	s.collectCycle(ctx, groupID, 1)

	return s.Get(ctx, groupID)
}

func (s *Service) Leave(ctx context.Context, groupID uuid.UUID) error {
	p, err := principal(ctx)
	if err != nil {
		return err
	}
	g, err := s.q.GetAjoGroup(ctx, groupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrGroupNotFound
	}
	if err != nil {
		return fmt.Errorf("load ajo group: %w", err)
	}
	if g.Status != "forming" {
		return problem.New(http.StatusConflict, "invalid_state", "You cannot leave an ajo that has started").
			WithDetail("Members depend on every contribution. Talk to the organiser instead.")
	}

	if g.CreatedByID == p.UserID {
		now := s.now().UTC()
		return s.q.UpdateAjoGroupStatus(ctx, ajodb.UpdateAjoGroupStatusParams{
			ID:        groupID,
			Status:    "cancelled",
			StartedAt: nil,
			EndedAt:   &now,
		})
	}
	return s.q.DeleteAjoMember(ctx, ajodb.DeleteAjoMemberParams{GroupID: groupID, UserID: p.UserID})
}

func (s *Service) ListCycles(ctx context.Context, groupID uuid.UUID) ([]CycleView, error) {
	_, err := s.Get(ctx, groupID)
	if err != nil {
		return nil, err
	}

	cycles, err := s.q.ListAjoCycles(ctx, groupID)
	if err != nil {
		return nil, fmt.Errorf("list cycles: %w", err)
	}
	contribs, err := s.q.ListAjoContributionsForGroup(ctx, groupID)
	if err != nil {
		return nil, fmt.Errorf("list contributions: %w", err)
	}

	contribsByCycle := make(map[uuid.UUID][]ContributionView)
	for _, c := range contribs {
		prof, err := s.customers.CustomerProfile(ctx, c.UserID)
		if err != nil {
			continue
		}
		contribsByCycle[c.CycleID] = append(contribsByCycle[c.CycleID], ContributionView{
			User:     prof,
			UserID:   c.UserID,
			Status:   c.Status,
			Attempts: int(c.Attempts),
			PaidAt:   c.PaidAt,
		})
	}

	out := make([]CycleView, len(cycles))
	for i, c := range cycles {
		payeeProf, err := s.customers.CustomerProfile(ctx, c.PayoutToUserID)
		if err != nil {
			return nil, fmt.Errorf("load payee profile: %w", err)
		}
		out[i] = CycleView{
			ID:            c.ID,
			GroupID:       c.GroupID,
			CycleNumber:   int(c.CycleNumber),
			DueAt:         c.DueAt,
			PayoutToUser:  payeeProf,
			PayoutToID:    c.PayoutToUserID,
			PayoutAmount:  money.New(c.PayoutAmountMinor, money.NGN),
			PayoutStatus:  c.PayoutStatus,
			Contributions: contribsByCycle[c.ID],
		}
	}
	return out, nil
}
