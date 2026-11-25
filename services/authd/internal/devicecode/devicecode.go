// Package devicecode is the mail device code (#383): the secret one enrolled
// device signs in to IMAP and SMTP with, in place of the person's password.
//
//	i10dc1.<device id>.<secret>
//
// The device id is the `authd.mail_devices` row's UUID as 32 lowercase hex
// digits, and the secret is 32 random bytes as 43 characters of unpadded, strict
// base64url: 83 characters in all. The API mints codes (TypeScript); authd
// verifies them and the mail front reads the device id out of them, both with
// Parse. testdata/vectors.json pins the format and the hash for both languages.
//
// ⚠ ONE SPELLING ONLY. A code that is not exactly this is not a code: no case
// folding, no padding, no whitespace, no other base64 alphabet. Go's base64
// decoder skips CR and LF even in strict mode, so the alphabet is checked byte by
// byte before anything is decoded (as internal/bindtoken learned from its fuzz).
//
// ⚠ THE PREFIX IS RESERVED, NOT JUST THE FORMAT. authd sends every password that
// starts "i10dc" to the device lane, where one that does not parse is refused.
// So a truncated or mistyped code never reaches Clerk or a company's directory,
// and never spends a failure-budget slot there.
package devicecode

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/i10-tech/i10/services/authd/internal/keyring"
)

const (
	// ReservedPrefix is what makes a password a device code attempt.
	ReservedPrefix = "i10dc"
	// Prefix starts every code of this version.
	Prefix = "i10dc1."

	// Len is a code's exact length.
	Len = len(Prefix) + idHexLen + 1 + secretB64Len

	idLen        = 16
	idHexLen     = 2 * idLen
	secretLen    = 32
	secretB64Len = 43 // base64.RawURLEncoding.EncodedLen(secretLen)

	// label separates this hash from every other HMAC under the same key.
	label = "i10/mail-device-code/v1\x00"

	urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	lowerHex    = "0123456789abcdef"
)

// Reasons a device code is refused. Stable log reason codes.
var (
	ErrMalformed = errors.New("device_code_malformed")
)

// Code is a parsed device code. Its zero value is not a code.
type Code struct {
	id     [idLen]byte
	secret [secretLen]byte
}

// New is the code for a device id and a secret. Production mints in the API;
// this is for tests and the test vectors.
func New(id [idLen]byte, secret [secretLen]byte) Code { return Code{id: id, secret: secret} }

// HasReservedPrefix reports whether a password belongs to the device lane.
func HasReservedPrefix(password string) bool { return strings.HasPrefix(password, ReservedPrefix) }

// Parse reads a code, or fails with ErrMalformed.
func Parse(s string) (Code, error) {
	if len(s) != Len || !strings.HasPrefix(s, Prefix) {
		return Code{}, ErrMalformed
	}
	rest := s[len(Prefix):]
	idHex, secret := rest[:idHexLen], rest[idHexLen+1:]
	if rest[idHexLen] != '.' || !only(idHex, lowerHex) || !only(secret, urlAlphabet) {
		return Code{}, ErrMalformed
	}
	var c Code
	if _, err := hex.Decode(c.id[:], []byte(idHex)); err != nil {
		return Code{}, ErrMalformed
	}
	// Strict: the two bits past the 32nd byte must be zero, so each secret has
	// exactly one spelling.
	raw, err := base64.RawURLEncoding.Strict().DecodeString(secret)
	if err != nil || len(raw) != secretLen {
		return Code{}, ErrMalformed
	}
	copy(c.secret[:], raw)
	return c, nil
}

// Of is the code a password is, when it is a well-formed one. The bind token
// (internal/bindtoken) covers its device, and the front and authd both read it
// with this one function from the same string.
func Of(password string) (Code, bool) {
	if !HasReservedPrefix(password) {
		return Code{}, false
	}
	c, err := Parse(password)
	return c, err == nil
}

// DeviceID is Of's device id as the UUID text Postgres writes, or "" for a
// password that is not a well-formed code.
func DeviceID(password string) string {
	if c, ok := Of(password); ok {
		return c.ID()
	}
	return ""
}

// ID is the device id as the UUID text Postgres writes (8-4-4-4-12, lowercase).
func (c Code) ID() string {
	h := hex.EncodeToString(c.id[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// IDBytes is the device id's 16 bytes.
func (c Code) IDBytes() [idLen]byte { return c.id }

// String is the code as a device holds it.
func (c Code) String() string {
	return Prefix + hex.EncodeToString(c.id[:]) + "." + base64.RawURLEncoding.EncodeToString(c.secret[:])
}

// Hash is what `authd.mail_devices.code_hash` stores for c under key:
//
//	HMAC-SHA256(key, "i10/mail-device-code/v1" 0x00 | 16 bytes of the id | 32 bytes of the secret)
//
// ⚠ THE ID IS INSIDE THE HASH. A row's hash opens only for the code that names
// that row, so a secret moved to another device's id (or a row copied under
// another id) verifies nowhere.
func Hash(key []byte, c Code) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(label))
	m.Write(c.id[:])
	m.Write(c.secret[:])
	return m.Sum(nil)
}

// Matches reports, in constant time, whether stored is c's hash under key.
func Matches(key []byte, c Code, stored []byte) bool {
	return hmac.Equal(Hash(key, c), stored)
}

// Keys is MAIL_DEVICE_CODE_KEYS: every key a code may have been hashed under,
// by `code_kid`. The API mints with one and authd verifies with all, so a key is
// rotated by adding the new one beside the old before minting with it.
type Keys = keyring.Ring

// ParseKeys reads MAIL_DEVICE_CODE_KEYS ("<id>:<base64 of at least 32 bytes>",
// comma-separated).
func ParseKeys(s string) (Keys, error) { return keyring.ParseRing("MAIL_DEVICE_CODE_KEYS", s) }

func only(s, alphabet string) bool { return strings.Trim(s, alphabet) == "" }
