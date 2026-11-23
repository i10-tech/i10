// Package bindtoken is the proof that a person's mail sign-in came through the
// mail front, and as whom (#383).
//
// ⚠ THIS IS THE ATTRIBUTION BOUNDARY. Stalwart sends every IMAP and SMTP sign-in
// to authd as an LDAP bind, and it does so again for a second sign-in on the
// same connection (UNAUTHENTICATE, then LOGIN), which the front cannot follow
// exactly. So the front, which looked the login up and knows which account it is
// crediting the connection to, puts a token in front of the password it forwards:
// an HMAC over that account's Clerk user id, an expiry and a nonce, under a key
// it shares with authd. authd accepts a person bind only with a valid token for
// the very account the bind DN names, and strips it before anything else looks
// at the password. A sign-in Stalwart takes from anywhere else (a client's own
// LOGIN after sign-in, a differential the front parsed one way and Stalwart
// another) carries a raw password, or a token for another account, and is
// refused.
//
// The format, as it sits in the LDAP simple-bind password:
//
//	i10mf1.<payload>.<the real password>
//
// payload is base64url (no padding) of
//
//	kid (1) | expiry, Unix seconds, big endian (8) | nonce (16) | mac (32)
//
// and mac is HMAC-SHA256 under key kid of
//
//	label | kid | uint16 length of uid | uid | expiry | nonce
//
// with label the fixed domain-separation string below. The real password is
// everything after the second dot, dots included.
//
// ⚠ THE TOKEN DOES NOT COVER THE PASSWORD, AND DOES NOT NEED TO. It says which
// account the front credited and that the bind came through the front; whether
// the password is right is still the provider's answer, checked by authd after
// the token is taken off. Nothing a client sends ever reaches authd with a
// token the client chose: the front mints it, and only on the way to Stalwart.
//
// ⚠ NO PASSWORD IS EVER READ AS A TOKEN BY ACCIDENT, OR THE OTHER WAY ROUND.
// authd requires the token on every person bind, so a password that happens to
// start with "i10mf1." is still wrapped by the front, and exactly one layer is
// taken off. There is no fallback to treating a bind as a raw password.
package bindtoken

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Prefix starts every token.
const Prefix = "i10mf1."

// TTL is how long a token is good for. The front mints one per sign-in and
// Stalwart binds with it within milliseconds; the front, Stalwart and authd
// share one host clock.
const TTL = 60 * time.Second

// skew is how far in the future an expiry may lie beyond TTL and still be
// accepted, for clocks that are not quite the same.
const skew = 5 * time.Second

// MinKeyLen is the shortest key accepted: an HMAC-SHA256 key shorter than its
// output is a key that can be guessed sooner than the MAC.
const MinKeyLen = 32

const urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// maxUIDLen bounds the user id a token is for. Clerk's are about 32 bytes.
const maxUIDLen = 256

const (
	label      = "i10-mailfront-bind-token/v1\x00"
	nonceLen   = 16
	macLen     = sha256.Size
	payloadLen = 1 + 8 + nonceLen + macLen
)

// Reasons a token is refused. Stable log reason codes.
var (
	ErrNoToken    = errors.New("bind_token_missing")
	ErrMalformed  = errors.New("bind_token_malformed")
	ErrUnknownKey = errors.New("bind_token_unknown_key")
	ErrBadMAC     = errors.New("bind_token_bad_mac")
	ErrExpired    = errors.New("bind_token_expired")
	ErrNoKeys     = errors.New("bind_token_no_keys_configured")
)

// Key is one signing key and its id.
type Key struct {
	ID     byte
	Secret []byte
}

// Keys is every key a verifier accepts, by id. The front signs with one; authd
// accepts the current and the previous one while a rotation is under way.
type Keys map[byte][]byte

// ParseKey reads one key as "<id>:<base64 secret>", id 0 to 255.
func ParseKey(s string) (Key, error) {
	id, secret, ok := strings.Cut(strings.TrimSpace(s), ":")
	if !ok {
		return Key{}, errors.New("bindtoken: a key is <id>:<base64 secret>")
	}
	n, err := strconv.ParseUint(id, 10, 8)
	if err != nil {
		// ⚠ NEVER QUOTE IT: a key written the wrong way round (`<secret>:<id>`)
		// would put the secret in the ERROR log.
		return Key{}, fmt.Errorf("bindtoken: the key id (%d bytes) is not 0 to 255", len(id))
	}
	raw, err := base64.StdEncoding.DecodeString(secret)
	if err != nil {
		if raw, err = base64.RawURLEncoding.DecodeString(secret); err != nil {
			return Key{}, fmt.Errorf("bindtoken: key %d is not base64", n)
		}
	}
	if len(raw) < MinKeyLen {
		return Key{}, fmt.Errorf("bindtoken: key %d is %d bytes, need at least %d", n, len(raw), MinKeyLen)
	}
	return Key{ID: byte(n), Secret: raw}, nil
}

// ParseKeys reads a comma-separated list of keys. Ids must be distinct.
func ParseKeys(s string) (Keys, error) {
	keys := Keys{}
	for _, part := range strings.Split(s, ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		k, err := ParseKey(part)
		if err != nil {
			return nil, err
		}
		if _, dup := keys[k.ID]; dup {
			return nil, fmt.Errorf("bindtoken: key id %d appears twice", k.ID)
		}
		keys[k.ID] = k.Secret
	}
	return keys, nil
}

// Wrap puts a fresh token for uid in front of password, under k, valid until
// now plus TTL.
func Wrap(k Key, uid, password string, now time.Time) (string, error) {
	if uid == "" || len(uid) > maxUIDLen {
		return "", fmt.Errorf("bindtoken: a user id of %d bytes", len(uid))
	}
	if len(k.Secret) < MinKeyLen {
		return "", errors.New("bindtoken: no signing key")
	}
	var nonce [nonceLen]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("bindtoken: no entropy for a nonce: %w", err)
	}
	return wrapWith(k, uid, password, now.Add(TTL), nonce), nil
}

func wrapWith(k Key, uid, password string, expires time.Time, nonce [nonceLen]byte) string {
	payload := make([]byte, 0, payloadLen)
	payload = append(payload, k.ID)
	payload = binary.BigEndian.AppendUint64(payload, uint64(expires.Unix()))
	payload = append(payload, nonce[:]...)
	payload = append(payload, mac(k.Secret, k.ID, uid, payload[1:9], nonce[:])...)
	return Prefix + base64.RawURLEncoding.EncodeToString(payload) + "." + password
}

// Unwrap checks the token in front of a bind's password for uid and returns
// the real password behind it. Any failure is an error and no password: the
// caller refuses the bind, it never retries the whole string as a password.
func Unwrap(keys Keys, uid, bindPassword string, now time.Time) (string, error) {
	if len(keys) == 0 {
		return "", ErrNoKeys
	}
	if uid == "" || len(uid) > maxUIDLen {
		return "", ErrMalformed
	}
	t, password, err := parse(bindPassword)
	if err != nil {
		return "", err
	}
	secret, ok := keys[t.kid]
	if !ok {
		return "", ErrUnknownKey
	}
	// ⚠ THE MAC FIRST, THE CLOCK AFTER: an expiry is only worth reading once it is
	// known to be ours.
	if !hmac.Equal(t.mac, mac(secret, t.kid, uid, t.expiry, t.nonce)) {
		return "", ErrBadMAC
	}
	exp := time.Unix(int64(binary.BigEndian.Uint64(t.expiry)), 0)
	if !now.Before(exp) || exp.After(now.Add(TTL+skew)) {
		return "", ErrExpired
	}
	if password == "" {
		return "", ErrMalformed
	}
	return password, nil
}

type token struct {
	kid    byte
	expiry []byte
	nonce  []byte
	mac    []byte
}

// parse splits a bind password into its token and the real password.
func parse(s string) (token, string, error) {
	rest, ok := strings.CutPrefix(s, Prefix)
	if !ok {
		return token{}, "", ErrNoToken
	}
	encoded, password, ok := strings.Cut(rest, ".")
	// ⚠ ONE SPELLING ONLY. Go's base64 decoder skips CR and LF, so a length check
	// on the decoded size alone let `\r` into a token that still verified (found
	// by FuzzUnwrap). The exact encoded length and the URL alphabet, nothing else.
	if !ok || len(encoded) != base64.RawURLEncoding.EncodedLen(payloadLen) ||
		strings.TrimLeft(encoded, urlAlphabet) != "" {
		return token{}, "", ErrMalformed
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(raw) != payloadLen {
		return token{}, "", ErrMalformed
	}
	return token{
		kid:    raw[0],
		expiry: raw[1:9],
		nonce:  raw[9 : 9+nonceLen],
		mac:    raw[9+nonceLen:],
	}, password, nil
}

func mac(secret []byte, kid byte, uid string, expiry, nonce []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(label))
	m.Write([]byte{kid})
	var n [2]byte
	binary.BigEndian.PutUint16(n[:], uint16(len(uid))) // at most maxUIDLen
	m.Write(n[:])
	m.Write([]byte(uid))
	m.Write(expiry)
	m.Write(nonce)
	return m.Sum(nil)
}
