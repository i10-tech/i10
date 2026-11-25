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
//	i10mf2.<payload>.<the real password>
//
// payload is base64url (no padding) of
//
//	kid (1) | expiry, Unix seconds, big endian (8) | nonce (16) | mac (32)
//
// and mac is HMAC-SHA256 under key kid of
//
//	label | kid | uint16 length of uid | uid | uint8 length of device | device | expiry | nonce
//
// with label the fixed domain-separation string below, and device the 16 bytes
// of the mail device id the real password names (internal/devicecode), or
// nothing when it names none. The real password is everything after the second
// dot, dots included.
//
// ⚠ THE DEVICE IS IN THE MAC, AND NEITHER SIDE IS TOLD IT. Wrap and Unwrap both
// read it out of the real password with devicecode.Of, so the device the
// front credits a connection to (its Grant) and the device authd verifies are
// the same by construction: a token minted for one device's code does not open
// behind another's, or behind an ordinary password. v1 tokens (`i10mf1.`) had no
// device and are refused: the front and authd ship in one image, in one pod, and
// switch together.
//
// ⚠ THE TOKEN DOES NOT COVER THE PASSWORD, AND DOES NOT NEED TO, beyond which
// device it names. It says which account (and device) the front credited and
// that the bind came through the front; whether
// the password is right is still the provider's answer, checked by authd after
// the token is taken off. Nothing a client sends ever reaches authd with a
// token the client chose: the front mints it, and only on the way to Stalwart.
//
// ⚠ NO PASSWORD IS EVER READ AS A TOKEN BY ACCIDENT, OR THE OTHER WAY ROUND.
// authd requires the token on every person bind, so a password that happens to
// start with "i10mf2." is still wrapped by the front, and exactly one layer is
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
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/keyring"
)

// Prefix starts every token.
const Prefix = "i10mf2."

// TTL is how long a token is good for. The front mints one per sign-in and
// Stalwart binds with it within milliseconds; the front, Stalwart and authd
// share one host clock.
const TTL = 60 * time.Second

// skew is how far in the future an expiry may lie beyond TTL and still be
// accepted, for clocks that are not quite the same.
const skew = 5 * time.Second

// MinKeyLen is the shortest key accepted.
const MinKeyLen = keyring.MinLen

const urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// maxUIDLen bounds the user id a token is for. Clerk's are about 32 bytes.
const maxUIDLen = 256

const (
	label      = "i10-mailfront-bind-token/v2\x00"
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
type Key = keyring.Key

// Keys is every key a verifier accepts, by id. The front signs with one; authd
// accepts the current and the previous one while a rotation is under way.
type Keys = keyring.Ring

// ParseKey reads one key as "<id>:<base64 secret>", id 0 to 255.
func ParseKey(s string) (Key, error) { return keyring.ParseKey("bindtoken", s) }

// ParseKeys reads a comma-separated list of keys. Ids must be distinct.
func ParseKeys(s string) (Keys, error) { return keyring.ParseRing("bindtoken", s) }

// Wrap puts a fresh token for uid, and for the device password names if it is a
// device code, in front of password, under k, valid until now plus TTL.
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
	payload = append(payload, mac(k.Secret, k.ID, uid, deviceOf(password), payload[1:9], nonce[:])...)
	return Prefix + base64.RawURLEncoding.EncodeToString(payload) + "." + password
}

// Unwrap checks the token in front of a bind's password for uid, and for the
// device the real password names, and returns the real password and that device
// (its UUID text, "" for none). Any failure is an error and no password: the
// caller refuses the bind, it never retries the whole string as a password.
//
// ⚠ THE DEVICE RETURNED IS THE ONE THE MAC COVERED. The caller verifies a
// device code against exactly this id, so the device authd checks is the one
// the front put in the token.
func Unwrap(keys Keys, uid, bindPassword string, now time.Time) (password, deviceID string, err error) {
	if len(keys) == 0 {
		return "", "", ErrNoKeys
	}
	if uid == "" || len(uid) > maxUIDLen {
		return "", "", ErrMalformed
	}
	t, password, err := parse(bindPassword)
	if err != nil {
		return "", "", err
	}
	secret, ok := keys[t.kid]
	if !ok {
		return "", "", ErrUnknownKey
	}
	code, isCode := devicecode.Of(password)
	var device []byte
	if isCode {
		id := code.IDBytes()
		device = id[:]
	}
	// ⚠ THE MAC FIRST, THE CLOCK AFTER: an expiry is only worth reading once it is
	// known to be ours.
	if !hmac.Equal(t.mac, mac(secret, t.kid, uid, device, t.expiry, t.nonce)) {
		return "", "", ErrBadMAC
	}
	exp := time.Unix(int64(binary.BigEndian.Uint64(t.expiry)), 0)
	if !now.Before(exp) || exp.After(now.Add(TTL+skew)) {
		return "", "", ErrExpired
	}
	if password == "" {
		return "", "", ErrMalformed
	}
	if isCode {
		deviceID = code.ID()
	}
	return password, deviceID, nil
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

func mac(secret []byte, kid byte, uid string, device, expiry, nonce []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(label))
	m.Write([]byte{kid})
	var n [2]byte
	binary.BigEndian.PutUint16(n[:], uint16(len(uid))) // at most maxUIDLen
	m.Write(n[:])
	m.Write([]byte(uid))
	m.Write([]byte{byte(len(device))}) // 0 or 16
	m.Write(device)
	m.Write(expiry)
	m.Write(nonce)
	return m.Sum(nil)
}

// deviceOf is the device a real password names, as the MAC covers it: the 16
// bytes of its id, or none.
func deviceOf(password string) []byte {
	c, ok := devicecode.Of(password)
	if !ok {
		return nil
	}
	id := c.IDBytes()
	return id[:]
}
