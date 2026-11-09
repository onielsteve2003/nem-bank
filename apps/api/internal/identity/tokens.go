package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// Session lifetimes. Access tokens are short so a stolen one is worth little; the refresh
// token slides with use but never past the session's absolute age.
const (
	accessTTL     = 10 * time.Minute
	refreshTTL    = 30 * 24 * time.Hour
	sessionMaxAge = 90 * 24 * time.Hour
)

const (
	jwtIssuer   = "nem-bank-api"
	jwtAudience = "nem-bank-app"
)

// Principal is the authenticated caller of a request.
type Principal struct {
	UserID    uuid.UUID
	SessionID uuid.UUID
	DeviceID  uuid.UUID
}

type principalKey struct{}

// WithPrincipal returns ctx carrying p.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, p)
}

// PrincipalFrom returns the caller, or false on an unauthenticated request.
func PrincipalFrom(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

// accessClaims are the access token's claims: the standard ones plus the session and
// device, so revoking either ends the token at once (see Authenticate).
type accessClaims struct {
	jwt.RegisteredClaims
	SessionID string `json:"sid"`
	DeviceID  string `json:"did"`
}

// tokenSigner signs and verifies EdDSA (Ed25519) access tokens. The kid header names the
// key, so a new key can be introduced later while tokens under the old one drain.
type tokenSigner struct {
	key ed25519.PrivateKey
	pub ed25519.PublicKey
	kid string
}

func newTokenSigner(seed []byte) (*tokenSigner, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("identity: signing key must be a %d-byte Ed25519 seed", ed25519.SeedSize)
	}
	key := ed25519.NewKeyFromSeed(seed)
	pub, ok := key.Public().(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("identity: ed25519 public key")
	}
	sum := sha256.Sum256(pub)
	return &tokenSigner{key: key, pub: pub, kid: hex.EncodeToString(sum[:8])}, nil
}

func (t *tokenSigner) sign(p Principal, now time.Time) (string, time.Time, error) {
	jti, err := newID()
	if err != nil {
		return "", time.Time{}, err
	}
	exp := now.Add(accessTTL)
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, accessClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: jwtIssuer, Audience: jwt.ClaimStrings{jwtAudience}, Subject: p.UserID.String(),
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(exp), ID: jti.String(),
		},
		SessionID: p.SessionID.String(),
		DeviceID:  p.DeviceID.String(),
	})
	tok.Header["kid"] = t.kid
	signed, err := tok.SignedString(t.key)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign access token: %w", err)
	}
	return signed, exp, nil
}

// verify checks signature, algorithm, issuer, audience and expiry. Only EdDSA is accepted,
// which rules out alg=none and HS256-with-the-public-key confusion.
func (t *tokenSigner) verify(raw string, now time.Time) (Principal, error) {
	var claims accessClaims
	_, err := jwt.ParseWithClaims(raw, &claims, func(tok *jwt.Token) (any, error) {
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
		return Principal{}, fmt.Errorf("verify access token: %w", err)
	}
	var p Principal
	var errs [3]error
	p.UserID, errs[0] = uuid.Parse(claims.Subject)
	p.SessionID, errs[1] = uuid.Parse(claims.SessionID)
	p.DeviceID, errs[2] = uuid.Parse(claims.DeviceID)
	if err := errors.Join(errs[:]...); err != nil {
		return Principal{}, fmt.Errorf("access token claims: %w", err)
	}
	return p, nil
}
