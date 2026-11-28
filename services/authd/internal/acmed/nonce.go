package acmed

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

// Stateless Replay-Nonces.
//
// ⚠ ISSUING A NONCE WRITES NOTHING. new-nonce and every response header are
// unauthenticated, so a nonce kept in Redis would let a flood fill the 128 MB
// noeviction instance every iPhone enrollment needs. A nonce instead carries
// its own expiry under a MAC:
//
//	base64url( kid(1) || random(16) || exp_be32(4) || HMAC-SHA256(K[kid], label || kid || random || exp)[:16] )
//
// 37 bytes, 50 characters. A nonce is spent (`SET enroll:acme:used:<nonce> NX`,
// single use) only by a request under a verified Mac path token (handler.go)
// that CHANGES STATE, and only after every check that can refuse it has
// passed (the spend rule in handler.go). Read-only requests (newAccount and
// every POST-as-GET) never spend, and a refused request writes nothing. So
// with a valid path token Redis holds at most (devices sealed in the last 10
// minutes) x MaxOrdersPerDevice orders plus the nonces their state changes
// spent, each nonce key for at most nonceLifetime plus nonceSpendMargin (clock
// skew between replicas); without one, nothing.
//
// The key ring is ACMED_NONCE_KEYS (also the account URL MAC, under its own
// label). It mints nothing and signs nothing: a nonce key in acmed is fine
// where a CA key or a permit key would not be.
const (
	nonceLifetime = 5 * time.Minute
	nonceRawLen   = 1 + 16 + 4 + 16
	// NonceLen is the exact length of a Replay-Nonce acmed issues.
	NonceLen   = 50
	nonceLabel = "i10/acme-replay-nonce/v1\x00"
)

var (
	errNonceMalformed = errors.New("acmed: malformed nonce")
	errNonceForged    = errors.New("acmed: nonce does not verify")
	errNonceExpired   = errors.New("acmed: nonce expired")
)

type nonceMinter struct {
	ring *enrolltoken.Ring
}

func nonceMAC(secret []byte, kid byte, random []byte, exp uint32) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(nonceLabel))
	m.Write([]byte{kid})
	m.Write(random)
	var e [4]byte
	binary.BigEndian.PutUint32(e[:], exp)
	m.Write(e[:])
	return m.Sum(nil)[:16]
}

// issue mints a nonce valid until now + nonceLifetime.
func (n nonceMinter) issue(now time.Time) (string, error) {
	kid, secret, err := n.ring.SigningKey()
	if err != nil {
		return "", err
	}
	raw := make([]byte, nonceRawLen)
	raw[0] = kid
	if _, err := rand.Read(raw[1:17]); err != nil {
		return "", err
	}
	exp := uint32(now.Add(nonceLifetime).Unix())
	binary.BigEndian.PutUint32(raw[17:21], exp)
	copy(raw[21:], nonceMAC(secret, kid, raw[1:17], exp))
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// check verifies a nonce statelessly and returns how long it still lives. It
// never touches Redis: the length and alphabet are checked before anything else.
func (n nonceMinter) check(nonce string, now time.Time) (time.Duration, error) {
	if len(nonce) != NonceLen {
		return 0, errNonceMalformed
	}
	for i := 0; i < len(nonce); i++ {
		c := nonce[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return 0, errNonceMalformed
		}
	}
	raw, err := base64.RawURLEncoding.DecodeString(nonce)
	if err != nil || len(raw) != nonceRawLen || base64.RawURLEncoding.EncodeToString(raw) != nonce {
		return 0, errNonceMalformed
	}
	secret, ok := n.ring.Secret(raw[0])
	if !ok {
		return 0, errNonceForged
	}
	exp := binary.BigEndian.Uint32(raw[17:21])
	if !hmac.Equal(raw[21:], nonceMAC(secret, raw[0], raw[1:17], exp)) {
		return 0, errNonceForged
	}
	left := time.Unix(int64(exp), 0).Sub(now)
	if left <= 0 {
		return 0, errNonceExpired
	}
	return left, nil
}
