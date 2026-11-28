// Package enrolltoken implements the signed, self-certifying tokens used by
// the enrollment plane (docs/research/enrollment-at-scale.md):
//
//  1. Edge link token (<v>.<eid>.<exp>.<mac>, ~68 chars): signed by i10-api
//     at POST /console/mail-devices/enrollments under ENROLL_EDGE_HMAC_KEY,
//     verified locally by enrolld before any network call, and verified again
//     by enrollctl before touching Redis.
//  2. Mac ACME OU permit token (50 base64url chars, <= 64-char RFC 5280 OU
//     limit): signed and verified exclusively by enrollctl under
//     ENROLLCTL_ACME_PERMIT_KEYS, embedded in the Mac's sealed ACME payload
//     Subject OU.
//  3. RFC 9562 UUIDv7 generation and canonical lowercase formatting.
package enrolltoken

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/keyring"
)

const (
	// LinkVersion is the version prefix on signed edge enrollment links.
	LinkVersion = "v1"

	linkMACLabel = "i10/enroll-edge-link/v1\x00"
	acmeMACLabel = "i10/acme-ou-permit/v1\x00"

	linkMACBytes     = 16 // 128-bit truncated HMAC-SHA256
	linkPayloadBytes = 1 + linkMACBytes
	linkMACB64Len    = 23 // base64url(17 bytes) without padding

	acmePermitRawLen = 1 + 16 + 4 + 16 // kid(1) + deviceID(16) + exp(4) + mac(16) = 37 bytes
	// ACMEPermitLen is the exact base64url length of an ACME OU permit token.
	ACMEPermitLen = 50
)

var (
	// ErrInvalid indicates a malformed token, unknown key id, or bad MAC.
	ErrInvalid = errors.New("enrolltoken: invalid token")
	// ErrExpired indicates a cryptographically valid token whose exp has passed.
	ErrExpired = errors.New("enrolltoken: token expired")
)

// Ring is an ordered list of HMAC keys where the first entry is the active
// signing key and every entry is accepted for verification (supporting rotation
// by prepending the new key, rolling verifiers, then removing the old key).
type Ring struct {
	keys []keyring.Key
	byID map[byte][]byte
}

// ParseRing parses a comma-separated list of "<id>:<base64 secret>" entries.
// Order is preserved: the first entry is the active signing key.
// An empty input returns an empty Ring (no keys) and nil error.
func ParseRing(what, raw string) (*Ring, error) {
	r := &Ring{byID: make(map[byte][]byte)}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, err := keyring.ParseKey(what, part)
		if err != nil {
			return nil, err
		}
		if _, dup := r.byID[k.ID]; dup {
			return nil, fmt.Errorf("%s: key id %d appears twice", what, k.ID)
		}
		r.keys = append(r.keys, k)
		r.byID[k.ID] = k.Secret
	}
	return r, nil
}

// ParseNonEmptyRing parses a key ring and rejects an empty list.
func ParseNonEmptyRing(what, raw string) (*Ring, error) {
	r, err := ParseRing(what, raw)
	if err != nil {
		return nil, err
	}
	if len(r.keys) == 0 {
		return nil, fmt.Errorf("%s: at least one key is required", what)
	}
	return r, nil
}

// Len returns the number of keys in the ring.
func (r *Ring) Len() int {
	if r == nil {
		return 0
	}
	return len(r.keys)
}

// IDs returns the key ids in ring order (first is the active signing key).
func (r *Ring) IDs() []int {
	if r == nil {
		return nil
	}
	out := make([]int, len(r.keys))
	for i, k := range r.keys {
		out[i] = int(k.ID)
	}
	return out
}

func (r *Ring) signingKey() (keyring.Key, error) {
	if r == nil || len(r.keys) == 0 {
		return keyring.Key{}, errors.New("enrolltoken: no signing key configured")
	}
	return r.keys[0], nil
}

// SigningKey is the active key (the first one) for a MAC defined elsewhere,
// such as acmed's Replay-Nonce.
func (r *Ring) SigningKey() (byte, []byte, error) {
	k, err := r.signingKey()
	return k.ID, k.Secret, err
}

// Secret is the key with id kid, for verification.
func (r *Ring) Secret(kid byte) ([]byte, bool) {
	if r == nil {
		return nil, false
	}
	s, ok := r.byID[kid]
	return s, ok
}

// LinkClaims holds the verified contents of a signed edge link token.
type LinkClaims struct {
	EnrollmentIDBytes [16]byte
	EnrollmentID      string
	ExpiresAt         time.Time
	KeyID             byte
}

// SignLink signs an edge enrollment link token in the canonical format
// `v1.<32-hex-eid>.<hex-exp>.<23-b64url-kid+mac>` (~68 chars) using the first
// key in ring.
func SignLink(ring *Ring, eid [16]byte, exp time.Time) (string, error) {
	key, err := ring.signingKey()
	if err != nil {
		return "", err
	}
	expSec := exp.UTC().Unix()
	if expSec <= 0 {
		return "", errors.New("enrolltoken: expiry must be positive")
	}
	var payload [linkPayloadBytes]byte
	payload[0] = key.ID
	copy(payload[1:], computeLinkMAC(key.Secret, key.ID, eid, uint64(expSec)))
	eidHex := hex.EncodeToString(eid[:])
	expHex := strconv.FormatUint(uint64(expSec), 16)
	macB64 := base64.RawURLEncoding.EncodeToString(payload[:])
	return LinkVersion + "." + eidHex + "." + expHex + "." + macB64, nil
}

// VerifyLink validates format, canonical encoding, HMAC-SHA256 (constant time),
// and expiry against now.
func VerifyLink(ring *Ring, token string, now time.Time) (LinkClaims, error) {
	if ring == nil || len(ring.byID) == 0 {
		return LinkClaims{}, ErrInvalid
	}
	if len(token) < 40 || len(token) > 128 {
		return LinkClaims{}, ErrInvalid
	}
	// Strictly 4 dot-separated parts: <v>.<eid>.<exp>.<mac>
	parts := strings.Split(token, ".")
	if len(parts) != 4 {
		return LinkClaims{}, ErrInvalid
	}
	ver, eidHex, expHex, macB64 := parts[0], parts[1], parts[2], parts[3]
	if ver != LinkVersion || len(eidHex) != 32 || len(expHex) == 0 || len(expHex) > 16 || len(macB64) != linkMACB64Len {
		return LinkClaims{}, ErrInvalid
	}
	if !isLowerHex(eidHex) || !isLowerHex(expHex) {
		return LinkClaims{}, ErrInvalid
	}
	if len(expHex) > 1 && expHex[0] == '0' {
		return LinkClaims{}, ErrInvalid
	}
	expSec, err := strconv.ParseUint(expHex, 16, 64)
	if err != nil || expSec == 0 || expSec > math.MaxInt64 {
		return LinkClaims{}, ErrInvalid
	}
	var eid [16]byte
	if _, err := hex.Decode(eid[:], []byte(eidHex)); err != nil {
		return LinkClaims{}, ErrInvalid
	}
	rawMAC, err := base64.RawURLEncoding.DecodeString(macB64)
	if err != nil || len(rawMAC) != linkPayloadBytes {
		return LinkClaims{}, ErrInvalid
	}
	// Reject non-canonical trailing bits in the last base64url character.
	if base64.RawURLEncoding.EncodeToString(rawMAC) != macB64 {
		return LinkClaims{}, ErrInvalid
	}
	kid := rawMAC[0]
	secret, ok := ring.byID[kid]
	if !ok {
		return LinkClaims{}, ErrInvalid
	}
	want := computeLinkMAC(secret, kid, eid, expSec)
	if !hmac.Equal(rawMAC[1:], want) {
		return LinkClaims{}, ErrInvalid
	}
	expTime := time.Unix(int64(expSec), 0).UTC()
	if now.UTC().Unix() > int64(expSec) {
		return LinkClaims{}, ErrExpired
	}
	return LinkClaims{
		EnrollmentIDBytes: eid,
		EnrollmentID:      FormatUUID(eid),
		ExpiresAt:         expTime,
		KeyID:             kid,
	}, nil
}

func computeLinkMAC(secret []byte, kid byte, eid [16]byte, expSec uint64) []byte {
	var expBuf [8]byte
	binary.BigEndian.PutUint64(expBuf[:], expSec)
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(linkMACLabel))
	h.Write([]byte{kid})
	h.Write(eid[:])
	h.Write(expBuf[:])
	sum := h.Sum(nil)
	return sum[:linkMACBytes]
}

// ACMEPermitClaims holds the verified contents of a Mac ACME OU permit token.
type ACMEPermitClaims struct {
	DeviceIDBytes [16]byte
	DeviceID      string
	ExpiresAt     time.Time
	KeyID         byte
}

// SignACMEPermit creates a 50-char base64url self-certifying Mac ACME OU permit
// token (`kid(1) || deviceID(16) || expUint32BE(4) || hmac16(16)`).
func SignACMEPermit(ring *Ring, deviceID [16]byte, exp time.Time) (string, error) {
	key, err := ring.signingKey()
	if err != nil {
		return "", err
	}
	expSec := exp.UTC().Unix()
	if expSec <= 0 || expSec > math.MaxUint32 {
		return "", errors.New("enrolltoken: ACME permit expiry out of uint32 range")
	}
	var raw [acmePermitRawLen]byte
	raw[0] = key.ID
	copy(raw[1:17], deviceID[:])
	binary.BigEndian.PutUint32(raw[17:21], uint32(expSec))
	copy(raw[21:], computeACMEPermitMAC(key.Secret, raw[:21]))
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// VerifyACMEPermit checks a 50-char base64url Mac ACME OU permit token.
func VerifyACMEPermit(ring *Ring, token string, now time.Time) (ACMEPermitClaims, error) {
	if ring == nil || len(ring.byID) == 0 {
		return ACMEPermitClaims{}, ErrInvalid
	}
	if len(token) != ACMEPermitLen {
		return ACMEPermitClaims{}, ErrInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != acmePermitRawLen {
		return ACMEPermitClaims{}, ErrInvalid
	}
	if base64.RawURLEncoding.EncodeToString(raw) != token {
		return ACMEPermitClaims{}, ErrInvalid
	}
	kid := raw[0]
	secret, ok := ring.byID[kid]
	if !ok {
		return ACMEPermitClaims{}, ErrInvalid
	}
	want := computeACMEPermitMAC(secret, raw[:21])
	if !hmac.Equal(raw[21:], want) {
		return ACMEPermitClaims{}, ErrInvalid
	}
	expSec := uint64(binary.BigEndian.Uint32(raw[17:21]))
	if expSec == 0 {
		return ACMEPermitClaims{}, ErrInvalid
	}
	if now.UTC().Unix() > int64(expSec) {
		return ACMEPermitClaims{}, ErrExpired
	}
	var devID [16]byte
	copy(devID[:], raw[1:17])
	return ACMEPermitClaims{
		DeviceIDBytes: devID,
		DeviceID:      FormatUUID(devID),
		ExpiresAt:     time.Unix(int64(expSec), 0).UTC(),
		KeyID:         kid,
	}, nil
}

func computeACMEPermitMAC(secret []byte, header []byte) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(acmeMACLabel))
	h.Write(header)
	sum := h.Sum(nil)
	return sum[:16]
}

// NewUUIDv7 generates an RFC 9562 UUIDv7 using the current UTC time.
func NewUUIDv7() ([16]byte, error) {
	return NewUUIDv7At(time.Now().UTC())
}

// NewUUIDv7At generates an RFC 9562 UUIDv7 stamped with t.
func NewUUIDv7At(t time.Time) ([16]byte, error) {
	var u [16]byte
	if _, err := rand.Read(u[6:]); err != nil {
		return u, fmt.Errorf("enrolltoken: uuid rand: %w", err)
	}
	ms := uint64(t.UTC().UnixMilli())
	u[0] = byte(ms >> 40)
	u[1] = byte(ms >> 32)
	u[2] = byte(ms >> 24)
	u[3] = byte(ms >> 16)
	u[4] = byte(ms >> 8)
	u[5] = byte(ms)
	// Version 7 (0111) in top 4 bits of byte 6.
	u[6] = (u[6] & 0x0f) | 0x70
	// RFC 9562 variant (10xx) in top 2 bits of byte 8.
	u[8] = (u[8] & 0x3f) | 0x80
	return u, nil
}

// FormatUUID returns the canonical lowercase dashed UUID spelling (8-4-4-4-12).
func FormatUUID(u [16]byte) string {
	var buf [36]byte
	hex.Encode(buf[0:8], u[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], u[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], u[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], u[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], u[10:16])
	return string(buf[:])
}

// ParseUUID parses a canonical lowercase dashed UUID (8-4-4-4-12).
func ParseUUID(s string) ([16]byte, error) {
	var u [16]byte
	if len(s) != 36 || s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return u, ErrInvalid
	}
	hexStr := s[0:8] + s[9:13] + s[14:18] + s[19:23] + s[24:36]
	if !isLowerHex(hexStr) {
		return u, ErrInvalid
	}
	if _, err := hex.Decode(u[:], []byte(hexStr)); err != nil {
		return u, ErrInvalid
	}
	return u, nil
}

func isLowerHex(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
