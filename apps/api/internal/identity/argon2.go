package identity

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2Params are argon2id's cost settings. The defaults are OWASP's first choice
// (19 MiB, 2 passes, 1 lane): about 30 ms per hash on a small server.
type Argon2Params struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
}

// DefaultArgon2 is used for passwords, PINs and security answers.
var DefaultArgon2 = Argon2Params{MemoryKiB: 19 * 1024, Time: 2, Threads: 1}

const (
	saltLen = 16
	keyLen  = 32
)

var errBadHash = errors.New("argon2id: malformed hash")

// Hasher hashes secrets with argon2id. Each hash holds MemoryKiB of RAM, so a semaphore
// caps how many run at once: a burst of logins on Render's 512 MB instance queues instead
// of running the process out of memory.
type Hasher struct {
	params Argon2Params
	slots  chan struct{}
}

// NewHasher allows at most concurrency hashes at a time.
func NewHasher(params Argon2Params, concurrency int) *Hasher {
	if concurrency < 1 {
		concurrency = 1
	}
	return &Hasher{params: params, slots: make(chan struct{}, concurrency)}
}

func (h *Hasher) acquire(ctx context.Context) error {
	select {
	case h.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("wait for hash slot: %w", ctx.Err())
	}
}

func (h *Hasher) release() { <-h.slots }

// Hash returns a PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>. The parameters
// travel with the hash, so they can be raised later without breaking stored hashes.
func (h *Hasher) Hash(ctx context.Context, secret string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("argon2id salt: %w", err)
	}
	if err := h.acquire(ctx); err != nil {
		return "", err
	}
	defer h.release()
	p := h.params
	key := argon2.IDKey([]byte(secret), salt, p.Time, p.MemoryKiB, p.Threads, keyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, p.MemoryKiB, p.Time, p.Threads, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// Verify reports whether secret matches encoded, comparing in constant time.
func (h *Hasher) Verify(ctx context.Context, secret, encoded string) (bool, error) {
	p, salt, want, err := decodeHash(encoded)
	if err != nil {
		return false, err
	}
	if err := h.acquire(ctx); err != nil {
		return false, err
	}
	defer h.release()
	got := argon2.IDKey([]byte(secret), salt, p.Time, p.MemoryKiB, p.Threads, uint32(len(want))) //nolint:gosec // len(want) is a decoded 32-byte key
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func decodeHash(encoded string) (Argon2Params, []byte, []byte, error) {
	parts := strings.Split(encoded, "$")
	// "", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash
	if len(parts) != 6 || parts[1] != "argon2id" {
		return Argon2Params{}, nil, nil, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return Argon2Params{}, nil, nil, errBadHash
	}
	var p Argon2Params
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.MemoryKiB, &p.Time, &p.Threads); err != nil {
		return Argon2Params{}, nil, nil, errBadHash
	}
	// Bound the cost a stored hash can demand, so a corrupted row cannot exhaust memory.
	if p.MemoryKiB == 0 || p.MemoryKiB > 256*1024 || p.Time == 0 || p.Time > 10 || p.Threads == 0 {
		return Argon2Params{}, nil, nil, errBadHash
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return Argon2Params{}, nil, nil, errBadHash
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) != keyLen {
		return Argon2Params{}, nil, nil, errBadHash
	}
	return p, salt, key, nil
}
