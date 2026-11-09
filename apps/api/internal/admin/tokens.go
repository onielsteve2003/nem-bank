package admin

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// sessionTTL is the console session's whole life: 8 hours, a working day, with no refresh
// (contract StaffSession).
const sessionTTL = 8 * time.Hour

const (
	jwtIssuer = "nem-bank-api"
	// jwtAudience is the contract's `console` audience. Customer tokens carry
	// nem-bank-app, so each realm's verifier refuses the other's tokens.
	jwtAudience = "console"
)

// Role is a staff role (contract StaffRole).
type Role string

// Staff roles.
const (
	RoleSupport    Role = "support"
	RoleCompliance Role = "compliance"
	RoleFinance    Role = "finance"
	RoleAdmin      Role = "admin"
)

func validRole(r Role) bool {
	return r == RoleSupport || r == RoleCompliance || r == RoleFinance || r == RoleAdmin
}

// Principal is the signed-in staff member. Roles are read from the database on every
// request, not from the token, so removing a role takes effect at once.
type Principal struct {
	StaffID   uuid.UUID
	SessionID uuid.UUID
	Name      string
	Roles     []Role
}

// HasAny reports whether p holds at least one of roles.
func (p Principal) HasAny(roles ...Role) bool {
	for _, want := range roles {
		if slices.Contains(p.Roles, want) {
			return true
		}
	}
	return false
}

type principalKey struct{}

// WithPrincipal returns ctx carrying p.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the staff caller, or false when the request is not a staff one.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

type staffClaims struct {
	jwt.RegisteredClaims
	SessionID string `json:"sid"`
}

type tokenSigner struct {
	key ed25519.PrivateKey
	pub ed25519.PublicKey
	kid string
}

func newTokenSigner(seed []byte) (*tokenSigner, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("admin: signing key must be a %d-byte Ed25519 seed", ed25519.SeedSize)
	}
	key := ed25519.NewKeyFromSeed(seed)
	pub, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("admin: ed25519 public key")
	}
	sum := sha256.Sum256(pub)
	return &tokenSigner{key: key, pub: pub, kid: hex.EncodeToString(sum[:8])}, nil
}

func (t *tokenSigner) sign(staffID, sessionID uuid.UUID, now, exp time.Time) (string, error) {
	jti, err := newID()
	if err != nil {
		return "", err
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, staffClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: jwtIssuer, Audience: jwt.ClaimStrings{jwtAudience}, Subject: staffID.String(),
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(exp), ID: jti.String(),
		},
		SessionID: sessionID.String(),
	})
	tok.Header["kid"] = t.kid
	signed, err := tok.SignedString(t.key)
	if err != nil {
		return "", fmt.Errorf("sign staff token: %w", err)
	}
	return signed, nil
}

// verify accepts only EdDSA under this realm's key, issuer and audience.
func (t *tokenSigner) verify(raw string, now time.Time) (staffID, sessionID uuid.UUID, err error) {
	var claims staffClaims
	_, err = jwt.ParseWithClaims(raw, &claims, func(tok *jwt.Token) (any, error) {
		if kid, _ := tok.Header["kid"].(string); kid != t.kid {
			return nil, errors.New("unknown signing key")
		}
		return t.pub, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodEdDSA.Alg()}),
		jwt.WithIssuer(jwtIssuer), jwt.WithAudience(jwtAudience),
		jwt.WithExpirationRequired(), jwt.WithIssuedAt(),
		jwt.WithTimeFunc(func() time.Time { return now }),
	)
	if err != nil {
		return uuid.Nil, uuid.Nil, fmt.Errorf("verify staff token: %w", err)
	}
	staffID, err1 := uuid.Parse(claims.Subject)
	sessionID, err2 := uuid.Parse(claims.SessionID)
	if err := errors.Join(err1, err2); err != nil {
		return uuid.Nil, uuid.Nil, fmt.Errorf("staff token claims: %w", err)
	}
	return staffID, sessionID, nil
}
