// Package developer is the developer platform (DEV-1 to DEV-4): scoped API keys, outbound
// webhooks with signed, retried, replayable deliveries, the sandbox payment simulator and the
// public API docs.
//
// A developer is an ordinary customer using the sandbox. Their API key authenticates as that
// customer, limited to the key's scopes, and can only call the operations the contract marks
// with apiKeyAuth. Money here is simulated; nothing in this package reaches a real rail.
package developer

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/onielsteve2003/nem-bank/apps/api/internal/developer/developerdb"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/identity"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/fieldcrypt"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/platform/problem"
	"github.com/onielsteve2003/nem-bank/apps/api/internal/transfers"
)

// StepUps spends the confirmation a customer earned before creating a key.
type StepUps interface {
	ConsumeStepUp(ctx context.Context, tx pgx.Tx, userID uuid.UUID, purpose, token string) error
}

// stepUpPurpose is the purpose a key-creation confirmation must have (contract StepUpPurpose).
const stepUpPurpose = "api_key"

// Config holds the service's dependencies.
type Config struct {
	Pool      *pgxpool.Pool
	Keyring   *fieldcrypt.Keyring
	StepUps   StepUps
	Transfers *transfers.Service
	// HTTPClient sends webhooks. Nil builds the hardened client (see safeClient). Tests pass
	// one that trusts their server.
	HTTPClient *http.Client
	// AllowPrivateTargets lets endpoint URLs point at private addresses. Tests only.
	AllowPrivateTargets bool
	Logger              *slog.Logger
	// Now defaults to time.Now.
	Now func() time.Time
}

// Service is the developer platform.
type Service struct {
	pool      *pgxpool.Pool
	q         *developerdb.Queries
	keyring   *fieldcrypt.Keyring
	stepUps   StepUps
	transfers *transfers.Service
	client    *http.Client
	private   bool
	insert    *river.Client[pgx.Tx]
	log       *slog.Logger
	now       func() time.Time
}

// NewService checks the configuration.
func NewService(cfg Config) (*Service, error) {
	if cfg.Pool == nil || cfg.Keyring == nil || cfg.Transfers == nil || cfg.Logger == nil {
		return nil, errors.New("developer: pool, keyring, transfers and logger are required")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = safeClient()
	}
	// Insert-only: the process's jobs.Runner works the delivery jobs (Register).
	insert, err := river.NewClient(riverpgxv5.New(cfg.Pool), &river.Config{Logger: cfg.Logger})
	if err != nil {
		return nil, fmt.Errorf("developer job client: %w", err)
	}
	return &Service{
		pool: cfg.Pool, q: developerdb.New(cfg.Pool), keyring: cfg.Keyring, stepUps: cfg.StepUps, transfers: cfg.Transfers,
		client: cfg.HTTPClient, private: cfg.AllowPrivateTargets, insert: insert, log: cfg.Logger.With("component", "developer"), now: cfg.Now,
	}, nil
}

func (s *Service) inTx(ctx context.Context, fn func(tx pgx.Tx, q *developerdb.Queries) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

func owner(ctx context.Context) (uuid.UUID, error) {
	p, ok := identity.PrincipalFrom(ctx)
	if !ok {
		return uuid.Nil, problem.Unauthorized()
	}
	return p.UserID, nil
}

const alphanumerics = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// randomString is n characters of [A-Za-z0-9] from the system's secure random source.
func randomString(n int) (string, error) {
	alphabet := big.NewInt(int64(len(alphanumerics)))
	b := make([]byte, n)
	for i := range b {
		v, err := rand.Int(rand.Reader, alphabet)
		if err != nil {
			return "", fmt.Errorf("random: %w", err)
		}
		b[i] = alphanumerics[v.Int64()]
	}
	return string(b), nil
}

// ---------------------------------------------------------------- API keys (DEV-1)

const (
	keyPrefix      = "nem_test_"
	keyLength      = len(keyPrefix) + 32
	maxLiveKeys    = 10
	prefixShown    = 13 // "nem_test_" and four characters
	maxEndpoints   = 5
	secretPrefix   = "whsec_"
	secretShownLen = 10
)

// Scopes a key can carry (contract ApiKeyScope).
var allScopes = []string{"accounts_read", "transactions_read", "transfers_read", "payment_links_write", "webhooks_manage"}

// Key is the caller's API key, attached to the request context by Authenticate.
type Key struct {
	ID     uuid.UUID
	Scopes []string
}

type keyCtx struct{}

// KeyFrom returns the API key behind the request, or false when it came from a signed-in session.
func KeyFrom(ctx context.Context) (Key, bool) {
	k, ok := ctx.Value(keyCtx{}).(Key)
	return k, ok
}

// Has reports whether the key carries scope.
func (k Key) Has(scope string) bool {
	for _, s := range k.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

func hashKey(secret string) []byte {
	h := sha256.Sum256([]byte(secret))
	return h[:]
}

// Authenticate verifies a bearer token as an API key (apiKeyAuth) and returns a context that
// carries its owner and its scopes. A key that is revoked, unknown, or belongs to a frozen
// customer is the same plain 401.
func (s *Service) Authenticate(ctx context.Context, bearer string) (context.Context, error) {
	if len(bearer) != keyLength || !strings.HasPrefix(bearer, keyPrefix) {
		return nil, problem.Unauthorized()
	}
	k, err := s.q.GetLiveAPIKeyByHash(ctx, hashKey(bearer))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, problem.Unauthorized()
	}
	if err != nil {
		return nil, fmt.Errorf("look up api key: %w", err)
	}
	if err := s.q.TouchAPIKey(ctx, developerdb.TouchAPIKeyParams{Now: s.now(), ID: k.ID}); err != nil {
		s.log.Warn("touch api key", "error", err.Error())
	}
	ctx = context.WithValue(ctx, keyCtx{}, Key{ID: k.ID, Scopes: k.Scopes})
	return identity.WithPrincipal(ctx, identity.Principal{UserID: k.UserID}), nil
}

// CreateKey makes a sandbox key. The secret comes back once and only its hash is kept. A
// signed-in session and a step-up confirmation are both needed: a key is a way into the account.
func (s *Service) CreateKey(ctx context.Context, name string, scopes []string, stepUpToken string) (developerdb.ApiKey, string, error) {
	uid, err := owner(ctx)
	if err != nil {
		return developerdb.ApiKey{}, "", err
	}
	if _, viaKey := KeyFrom(ctx); viaKey {
		return developerdb.ApiKey{}, "", problem.Forbidden()
	}
	name = strings.TrimSpace(name)
	if n := len([]rune(name)); n < 1 || n > 40 {
		return developerdb.ApiKey{}, "", problem.Validation(problem.Field("/name", "length", "Name the key in 1 to 40 characters."))
	}
	seen := map[string]bool{}
	for _, sc := range scopes {
		known := false
		for _, a := range allScopes {
			known = known || a == sc
		}
		if !known || seen[sc] {
			return developerdb.ApiKey{}, "", problem.Validation(problem.Field("/scopes", "invalid", "Pick each scope once, from the list."))
		}
		seen[sc] = true
	}
	if len(scopes) == 0 {
		return developerdb.ApiKey{}, "", problem.Validation(problem.Field("/scopes", "required", "Pick at least one scope."))
	}
	rest, err := randomString(keyLength - len(keyPrefix))
	if err != nil {
		return developerdb.ApiKey{}, "", err
	}
	secret := keyPrefix + rest
	id, err := uuid.NewV7()
	if err != nil {
		return developerdb.ApiKey{}, "", fmt.Errorf("key id: %w", err)
	}
	now := s.now().UTC()
	var out developerdb.ApiKey
	err = s.inTx(ctx, func(tx pgx.Tx, q *developerdb.Queries) error {
		if s.stepUps == nil {
			return identity.ErrStepUpRequired
		}
		if err := s.stepUps.ConsumeStepUp(ctx, tx, uid, stepUpPurpose, stepUpToken); err != nil {
			return err
		}
		n, err := q.CountLiveAPIKeys(ctx, uid)
		if err != nil {
			return fmt.Errorf("count keys: %w", err)
		}
		if n >= maxLiveKeys {
			return problem.Conflict("You already have 10 active keys. Revoke one first.")
		}
		if err := q.InsertAPIKey(ctx, developerdb.InsertAPIKeyParams{
			ID: id, UserID: uid, Name: name, Prefix: secret[:prefixShown], KeyHash: hashKey(secret), Scopes: scopes, CreatedAt: now,
		}); err != nil {
			return fmt.Errorf("insert key: %w", err)
		}
		out = developerdb.ApiKey{ID: id, UserID: uid, Name: name, Prefix: secret[:prefixShown], Scopes: scopes, CreatedAt: now}
		return nil
	})
	return out, secret, err
}

// Keys lists the caller's keys, newest first. Secrets are never returned again.
func (s *Service) Keys(ctx context.Context) ([]developerdb.ApiKey, error) {
	uid, err := owner(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListAPIKeys(ctx, uid)
	if err != nil {
		return nil, fmt.Errorf("list keys: %w", err)
	}
	return rows, nil
}

// RevokeKey ends a key at once (the lookup is per request, so there is no cache to wait out).
// Revoking one already revoked is fine; a key that is not the caller's is "not found".
func (s *Service) RevokeKey(ctx context.Context, id uuid.UUID) error {
	uid, err := owner(ctx)
	if err != nil {
		return err
	}
	if _, viaKey := KeyFrom(ctx); viaKey {
		return problem.Forbidden()
	}
	if _, err := s.q.RevokeAPIKey(ctx, developerdb.RevokeAPIKeyParams{ID: id, UserID: uid, Now: ptr(s.now())}); errors.Is(err, pgx.ErrNoRows) {
		return problem.NotFound("API key")
	} else if err != nil {
		return fmt.Errorf("revoke key: %w", err)
	}
	return nil
}

// WithKey returns ctx carrying k, as Authenticate does. Tests of the layers above use it to
// stand in for a verified key.
func WithKey(ctx context.Context, k Key) context.Context { return context.WithValue(ctx, keyCtx{}, k) }
