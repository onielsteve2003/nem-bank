// Package console is the staff console's server side (T30.5): customer search and 360, the
// KYC, fraud, dispute and support queues, the ledger explorer, configuration, feature flags and
// the audit log. Staff authentication and maker-checker live in package admin; this package is
// the part that reaches across domains, so it depends on them through their services and
// never reads another domain's tables except for read-only reports.
//
// Every operation here is gated by the contract's x-roles in the request validator before it
// runs. Methods that change anything write an audit entry in the same transaction.
package console

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/accounts"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/admin"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/audit"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/console/consoledb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/fx"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/kyc"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/limits"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/support"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Admin     *admin.Service
	KYC       *kyc.Service
	Support   *support.Service
	Transfers *transfers.Service
	Accounts  *accounts.Service
	Identity  *identity.Service
	FX        *fx.Service
	Limits    *limits.Service
	// LinkKey signs the short-lived links to KYC photos.
	LinkKey []byte
	// RefundApprovalMinor is the refund size, in kobo, above which a dispute refund goes to
	// maker-checker instead of posting at once (ADM-6, ADM-10).
	RefundApprovalMinor int64
	Logger              *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// DefaultRefundApprovalMinor is ₦50,000: a refund this large needs a second pair of eyes.
const DefaultRefundApprovalMinor = 50_000 * 100

// Service is the console's cross-domain logic.
type Service struct {
	pool                *pgxpool.Pool
	q                   *consoledb.Queries
	admin               *admin.Service
	kyc                 *kyc.Service
	support             *support.Service
	transfers           *transfers.Service
	accounts            *accounts.Service
	identity            *identity.Service
	fx                  *fx.Service
	limits              *limits.Service
	linkKey             []byte
	refundApprovalMinor int64
	log                 *slog.Logger
	now                 func() time.Time
}

// NewService checks the configuration and registers the maker-checker actions this package
// carries out (unfreeze, limit override, ledger adjustment, configuration change, dispute
// refund). Call it once, while wiring the app.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Admin == nil || cfg.KYC == nil || cfg.Support == nil || cfg.Transfers == nil ||
		cfg.Accounts == nil || cfg.Identity == nil || cfg.FX == nil || cfg.Limits == nil || cfg.Logger == nil {
		return nil, errors.New("console: pool, admin, kyc, support, transfers, accounts, identity, fx, limits and logger are required")
	}
	if len(cfg.LinkKey) < 32 {
		return nil, errors.New("console: link key must be at least 32 bytes")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.RefundApprovalMinor <= 0 {
		cfg.RefundApprovalMinor = DefaultRefundApprovalMinor
	}
	s := &Service{
		pool: cfg.Pool, q: consoledb.New(cfg.Pool), admin: cfg.Admin, kyc: cfg.KYC, support: cfg.Support, transfers: cfg.Transfers,
		accounts: cfg.Accounts, identity: cfg.Identity, fx: cfg.FX, limits: cfg.Limits, linkKey: cfg.LinkKey,
		refundApprovalMinor: cfg.RefundApprovalMinor, log: cfg.Logger, now: cfg.Now,
	}
	s.registerActions()
	return s, nil
}

func (s *Service) inTx(ctx context.Context, fn func(tx pgx.Tx, q *consoledb.Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// staff is the signed-in staff member; every operation here needs one.
func staff(ctx context.Context) (admin.Principal, error) {
	p, ok := admin.PrincipalFrom(ctx)
	if !ok {
		return admin.Principal{}, problem.Unauthorized()
	}
	return p, nil
}

// actorOf names a staff member in the audit log. Staff are named there, customers are not.
func actorOf(p admin.Principal) audit.Actor {
	id := p.StaffID.String()
	name := p.Name
	return audit.Actor{Type: audit.ActorStaff, ID: &id, Name: &name}
}

func (s *Service) record(ctx context.Context, tx pgx.Tx, actor audit.Actor, action, resourceType, resourceID string, meta map[string]any) error {
	if _, err := audit.Append(ctx, tx, audit.Input{Actor: actor, Action: action, ResourceType: resourceType, ResourceID: resourceID, Metadata: meta}, s.now()); err != nil {
		return fmt.Errorf("audit %s: %w", action, err)
	}
	return nil
}

// maskEmail keeps the first letter and the domain: enough to recognise, not enough to use.
func maskEmail(e string) string {
	at := strings.LastIndex(e, "@")
	if at < 1 {
		return "***"
	}
	return e[:1] + "***" + e[at:]
}

// maskPhone keeps the country code and the last four digits.
func maskPhone(p string) string {
	if len(p) < 8 {
		return "***"
	}
	return p[:4] + "******" + p[len(p)-4:]
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

func ptr[T any](v T) *T { return &v }
