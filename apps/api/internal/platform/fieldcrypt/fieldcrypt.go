// Package fieldcrypt encrypts single database fields (BVN, NIN, ID numbers) with
// AES-256-GCM under versioned keys, so a leaked backup or a read-only SQL injection shows
// ciphertext, not identity numbers.
//
// A ciphertext is: format byte (1) | key version (uint16, big endian) | 12-byte nonce |
// sealed data with its 16-byte tag. The version lets keys rotate: new writes use the
// current key, old rows still decrypt under theirs, and NeedsRewrap finds the rows a
// background re-encryption should visit before an old key is retired.
//
// Every call takes associated data naming where the value lives ("kyc_identifiers.bvn:"
// plus the row's owner). GCM authenticates it, so a ciphertext copied into another
// customer's row, or another column, fails to decrypt instead of revealing someone else's
// number.
package fieldcrypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	formatV1   byte = 1
	headerSize      = 1 + 2
	nonceSize       = 12
	// KeySize is the AES-256 key length.
	KeySize = 32
)

// ErrDecrypt is any ciphertext that does not open: tampered, truncated, moved to another
// row, or under a key this process does not hold. Callers cannot tell which, by design.
var ErrDecrypt = errors.New("fieldcrypt: cannot decrypt")

// Keyring holds every key version still in use and encrypts with the newest.
type Keyring struct {
	current  uint16
	aeads    map[uint16]cipher.AEAD
	indexKey []byte
}

// New builds a keyring from key versions (each 32 bytes) and the blind-index key (32+
// bytes, separate from the encryption keys). The highest version encrypts.
func New(keys map[uint16][]byte, indexKey []byte) (*Keyring, error) {
	if len(keys) == 0 {
		return nil, errors.New("fieldcrypt: at least one key is required")
	}
	if len(indexKey) < KeySize {
		return nil, errors.New("fieldcrypt: the index key must be at least 32 bytes")
	}
	k := &Keyring{aeads: make(map[uint16]cipher.AEAD, len(keys)), indexKey: append([]byte(nil), indexKey...)}
	for v, key := range keys {
		if v == 0 {
			return nil, errors.New("fieldcrypt: key versions start at 1")
		}
		if len(key) != KeySize {
			return nil, fmt.Errorf("fieldcrypt: key v%d is %d bytes, need %d", v, len(key), KeySize)
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, fmt.Errorf("fieldcrypt: key v%d: %w", v, err)
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			return nil, fmt.Errorf("fieldcrypt: key v%d: %w", v, err)
		}
		k.aeads[v] = aead
		k.current = max(k.current, v)
	}
	return k, nil
}

// Current is the key version new ciphertexts use.
func (k *Keyring) Current() uint16 { return k.current }

// Encrypt seals plaintext under the current key, bound to aad. Nonces are random: at 96
// bits, a key can seal billions of fields before a repeat becomes a real risk, far beyond
// this bank's rows, and rotation resets the count.
func (k *Keyring) Encrypt(plaintext, aad []byte) ([]byte, error) {
	aead := k.aeads[k.current]
	out := make([]byte, headerSize+nonceSize, headerSize+nonceSize+len(plaintext)+aead.Overhead())
	out[0] = formatV1
	binary.BigEndian.PutUint16(out[1:3], k.current)
	if _, err := rand.Read(out[headerSize:]); err != nil {
		return nil, fmt.Errorf("fieldcrypt: nonce: %w", err)
	}
	return aead.Seal(out, out[headerSize:], plaintext, k.associated(out[:headerSize], aad)), nil
}

// Decrypt opens a ciphertext from Encrypt with the same aad.
func (k *Keyring) Decrypt(ciphertext, aad []byte) ([]byte, error) {
	v, ok := Version(ciphertext)
	if !ok {
		return nil, ErrDecrypt
	}
	aead, ok := k.aeads[v]
	if !ok || len(ciphertext) < headerSize+nonceSize+aead.Overhead() {
		return nil, ErrDecrypt
	}
	nonce := ciphertext[headerSize : headerSize+nonceSize]
	plain, err := aead.Open(nil, nonce, ciphertext[headerSize+nonceSize:], k.associated(ciphertext[:headerSize], aad))
	if err != nil {
		return nil, ErrDecrypt
	}
	return plain, nil
}

// associated authenticates the header too, so the version byte cannot be edited to steer
// decryption to another key.
func (k *Keyring) associated(header, aad []byte) []byte {
	return append(append(make([]byte, 0, len(header)+len(aad)), header...), aad...)
}

// Version reads a ciphertext's key version.
func Version(ciphertext []byte) (uint16, bool) {
	if len(ciphertext) < headerSize || ciphertext[0] != formatV1 {
		return 0, false
	}
	return binary.BigEndian.Uint16(ciphertext[1:3]), true
}

// NeedsRewrap reports whether a ciphertext is under an older key than Current.
func (k *Keyring) NeedsRewrap(ciphertext []byte) bool {
	v, ok := Version(ciphertext)
	return ok && v != k.current
}

// Rewrap decrypts under the old key and seals under the current one.
func (k *Keyring) Rewrap(ciphertext, aad []byte) ([]byte, error) {
	plain, err := k.Decrypt(ciphertext, aad)
	if err != nil {
		return nil, err
	}
	defer clear(plain)
	return k.Encrypt(plain, aad)
}

// BlindIndex is a keyed hash for equality lookups ("is this BVN already on an account?")
// without decrypting every row. domain separates uses, so the same number gives unrelated
// indexes for BVN and NIN. It stays fixed across encryption-key rotations.
func (k *Keyring) BlindIndex(domain string, value []byte) []byte {
	mac := hmac.New(sha256.New, k.indexKey)
	mac.Write([]byte(domain))
	mac.Write([]byte{0})
	mac.Write(value)
	return mac.Sum(nil)
}
