// Package bindtoken is the proof that a person's mail sign-in came through the
// mail front, as whom, and what the front saw of the connection (#383).
//
// ⚠ THIS IS THE ATTRIBUTION BOUNDARY. Stalwart sends every IMAP and SMTP sign-in
// to authd as an LDAP bind, and it does so again for a second sign-in on the
// same connection (UNAUTHENTICATE, then LOGIN), which the front cannot follow
// exactly. So the front, which looked the login up and knows which account it is
// crediting the connection to, puts a token in front of the password it forwards:
// an HMAC over that account's Clerk user id, an expiry, a nonce and what the
// front attests about the connection, under a key it shares with authd. authd
// accepts a person bind only with a valid token for the very account the bind DN
// names, and strips it before anything else looks at the password. A sign-in
// Stalwart takes from anywhere else (a client's own LOGIN after sign-in, a
// differential the front parsed one way and Stalwart another) carries a raw
// password, or a token for another account, and is refused.
//
// The format, as it sits in the LDAP simple-bind password:
//
//	i10mf3.<payload>.<the real password>
//
// payload is base64url (no padding) of one fixed-length record, 195 bytes,
// with no optional encodings (every field is always there, zeroes when absent):
//
//	kid 1 | expiry, Unix seconds, big endian 8 | nonce 16 |
//	mode 1 | protocol 1 | address family 1 | address 16 |
//	certificate key present 1 | key 32 | subject CN length 1 | CN 64 |
//	device present 1 | device 16 | reserved 4 | mac 32
//
// and mac is HMAC-SHA256 under key kid of
//
//	label | uint16 length of uid | uid | the payload up to the mac
//
// with label the fixed domain-separation string below. Every byte the front
// sets is under the MAC; the unused tails (an IPv4 address's last 12 bytes, a
// CN's padding, an absent key or device) and the reserved bytes must be zero, so
// each set of claims has exactly one encoding. The real password is everything
// after the second dot, dots included.
//
// ⚠ THE MODE PARTITIONS THE PASSWORDS (Unwrap, the table in
// docs/research/mail-device-binding.md section 11):
//
//   - password: a real password, not empty, not starting "i10dc"; no device, no
//     certificate key.
//   - device_code: a real password starting "i10dc". When it parses
//     (devicecode.Of) the device is present and equal to the code's id; when it
//     does not, the device is absent and authd refuses it as malformed, under the
//     throttle. A certificate key only on IMAP.
//   - external: an exactly empty real password, IMAP, a certificate key and a
//     device. The front proved the key in the TLS handshake (AUTHENTICATE
//     EXTERNAL); authd checks it is the device row's.
//
// So a token for one mode never opens behind another's password, and the device
// a code names is still read from the password, by the same parser, on both
// sides: the device the front credits a connection to (its Grant) and the device
// authd verifies are the same by construction.
//
// ⚠ A CERTIFICATE KEY NEVER RIDES ON AN SMTP TOKEN. Only 993 asks for a client
// certificate, so a key on SMTP is a front that is wrong, and it is refused.
//
// ⚠ THE TOKEN DOES NOT COVER THE PASSWORD, AND DOES NOT NEED TO, beyond its mode
// and which device it names. Whether the password is right is still the
// provider's answer (or the device code's hash), checked by authd after the
// token is taken off. For `external` there is no password: the front's MAC is
// the claim that the key was proved, which is why `external` moves part of the
// authentication into the front (services/authd/README.md, "The bind token").
// Nothing a client sends ever reaches authd with a token the client chose: the
// front mints it, and only on the way to Stalwart.
//
// ⚠ NO PASSWORD IS EVER READ AS A TOKEN BY ACCIDENT, OR THE OTHER WAY ROUND.
// authd requires the token on every person bind, so a password that happens to
// start with "i10mf3." is still wrapped by the front, and exactly one layer is
// taken off. There is no fallback to treating a bind as a raw password. Older
// tokens (`i10mf1.`, `i10mf2.`) are refused: the front and authd ship in one
// image, in one pod, and switch together.
package bindtoken

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/keyring"
)

// Prefix starts every token.
const Prefix = "i10mf3."

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

// MaxCNLen bounds the certificate subject CN a token carries. A Mac's is its
// serial (about 10 characters); the front treats a longer one as no
// certificate at all, never truncates it.
const MaxCNLen = 64

// CertKeyLen is a certificate key's length: SHA-256 of its SubjectPublicKeyInfo.
const CertKeyLen = sha256.Size

const (
	label    = "i10-mailfront-bind-token/v3\x00"
	nonceLen = 16
	macLen   = sha256.Size
	idLen    = 16

	// Offsets into the payload. Each field is always present.
	offKID      = 0
	offExpiry   = offKID + 1
	offNonce    = offExpiry + 8
	offMode     = offNonce + nonceLen
	offProto    = offMode + 1
	offFamily   = offProto + 1
	offAddr     = offFamily + 1
	offKeyHas   = offAddr + 16
	offKey      = offKeyHas + 1
	offCNLen    = offKey + CertKeyLen
	offCN       = offCNLen + 1
	offDevHas   = offCN + MaxCNLen
	offDev      = offDevHas + 1
	offReserved = offDev + idLen
	offMAC      = offReserved + 4
	payloadLen  = offMAC + macLen // 195: a multiple of 3, so base64 has no partial group
)

// Mode is what a sign-in's real password is (the partition above).
type Mode byte

const (
	ModePassword   Mode = 1
	ModeDeviceCode Mode = 2
	ModeExternal   Mode = 3
)

func (m Mode) String() string {
	switch m {
	case ModePassword:
		return "password"
	case ModeDeviceCode:
		return "device_code"
	case ModeExternal:
		return "external"
	}
	return "unknown"
}

// Protocol is the listener the sign-in came in on.
type Protocol byte

const (
	IMAP Protocol = 1
	SMTP Protocol = 2
)

func (p Protocol) String() string {
	switch p {
	case IMAP:
		return "imap"
	case SMTP:
		return "smtp"
	}
	return "unknown"
}

const (
	family4 = 4
	family6 = 6
)

// Reasons a token is refused. Stable log reason codes.
var (
	ErrNoToken    = errors.New("bind_token_missing")
	ErrMalformed  = errors.New("bind_token_malformed")
	ErrUnknownKey = errors.New("bind_token_unknown_key")
	ErrBadMAC     = errors.New("bind_token_bad_mac")
	ErrExpired    = errors.New("bind_token_expired")
	ErrNoKeys     = errors.New("bind_token_no_keys_configured")
	// ErrMode: the token verified, but its claims do not fit the real password
	// behind it (the mode partition).
	ErrMode = errors.New("bind_token_mode_mismatch")
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

// Attest is what the front saw of the connection a sign-in came in on.
type Attest struct {
	Protocol Protocol
	// Addr is the client's address: IPv4, or IPv6 that is not an IPv4-mapped
	// one, with no zone.
	Addr netip.Addr
	// CertKey is SHA-256 of the SubjectPublicKeyInfo of the client certificate
	// the front verified, or nil. CertCN is that certificate's subject CN, at
	// most MaxCNLen bytes; only with a key.
	CertKey []byte
	CertCN  string
}

// Claims is a token that verified: the real password behind it and everything
// the front attested.
type Claims struct {
	Password string
	Mode     Mode
	Attest
	// DeviceID is the device the MAC covered, as the UUID text Postgres writes,
	// "" for none.
	DeviceID string
}

// Wrap puts a fresh token for uid in front of password, under k, valid until now
// plus TTL. The mode is the password's: device_code for one that starts "i10dc"
// (with the device it names when it parses), password otherwise. An empty
// password is not a sign-in this makes a token for: AUTHENTICATE EXTERNAL uses
// WrapExternal.
func Wrap(k Key, uid, password string, at Attest, now time.Time) (string, error) {
	if password == "" {
		return "", errors.New("bindtoken: an empty password (EXTERNAL is WrapExternal)")
	}
	c := Claims{Password: password, Mode: ModePassword, Attest: at}
	if devicecode.HasReservedPrefix(password) {
		c.Mode = ModeDeviceCode
		c.DeviceID = devicecode.DeviceID(password)
	}
	return wrapClaims(k, uid, c, now)
}

// WrapExternal makes the token for an AUTHENTICATE EXTERNAL sign-in: no real
// password, the device the front found by the certificate's key, IMAP.
func WrapExternal(k Key, uid, deviceID string, at Attest, now time.Time) (string, error) {
	return wrapClaims(k, uid, Claims{Mode: ModeExternal, Attest: at, DeviceID: deviceID}, now)
}

func wrapClaims(k Key, uid string, c Claims, now time.Time) (string, error) {
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
	return wrapWith(k, uid, c, now.Add(TTL), nonce)
}

// wrapWith encodes c, refusing claims Unwrap would refuse: the front must never
// mint a token authd cannot read the same way.
func wrapWith(k Key, uid string, c Claims, expires time.Time, nonce [nonceLen]byte) (string, error) {
	p := make([]byte, payloadLen)
	p[offKID] = k.ID
	binary.BigEndian.PutUint64(p[offExpiry:], uint64(expires.Unix()))
	copy(p[offNonce:], nonce[:])
	p[offMode] = byte(c.Mode)
	p[offProto] = byte(c.Protocol)
	switch {
	case !c.Addr.IsValid() || c.Addr.Zone() != "" || c.Addr.Is4In6():
		return "", errors.New("bindtoken: the client address must be IPv4 or plain IPv6")
	case c.Addr.Is4():
		p[offFamily] = family4
		a := c.Addr.As4()
		copy(p[offAddr:], a[:])
	default:
		p[offFamily] = family6
		a := c.Addr.As16()
		copy(p[offAddr:], a[:])
	}
	if c.CertKey != nil {
		if len(c.CertKey) != CertKeyLen {
			return "", errors.New("bindtoken: a certificate key is 32 bytes")
		}
		p[offKeyHas] = 1
		copy(p[offKey:], c.CertKey)
	}
	if len(c.CertCN) > MaxCNLen {
		return "", errors.New("bindtoken: a certificate CN of more than 64 bytes")
	}
	p[offCNLen] = byte(len(c.CertCN))
	copy(p[offCN:], c.CertCN)
	if c.DeviceID != "" {
		id, ok := devicecode.ParseIDText(c.DeviceID)
		if !ok {
			return "", errors.New("bindtoken: a device id that is not a UUID")
		}
		p[offDevHas] = 1
		copy(p[offDev:], id[:])
	}
	if err := checkStructure(p); err != nil {
		return "", fmt.Errorf("bindtoken: claims a verifier would refuse: %w", err)
	}
	if _, err := claimsOf(p, c.Password); err != nil {
		return "", fmt.Errorf("bindtoken: claims a verifier would refuse: %w", err)
	}
	copy(p[offMAC:], mac(k.Secret, uid, p[:offMAC]))
	return Prefix + base64.RawURLEncoding.EncodeToString(p) + "." + c.Password, nil
}

// Unwrap checks the token in front of a bind's password for uid and returns
// what it claims. Any failure is an error and no claims: the caller refuses the
// bind, it never retries the whole string as a password.
//
// ⚠ THE DEVICE RETURNED IS THE ONE THE MAC COVERED, and for a device code it is
// also the one the password names. The caller verifies a code, or the
// certificate key, against exactly this id.
func Unwrap(keys Keys, uid, bindPassword string, now time.Time) (Claims, error) {
	if len(keys) == 0 {
		return Claims{}, ErrNoKeys
	}
	if uid == "" || len(uid) > maxUIDLen {
		return Claims{}, ErrMalformed
	}
	p, password, err := parse(bindPassword)
	if err != nil {
		return Claims{}, err
	}
	secret, ok := keys[p[offKID]]
	if !ok {
		return Claims{}, ErrUnknownKey
	}
	// ⚠ THE MAC FIRST, THE CLOCK AND THE CLAIMS AFTER: none of them is worth
	// reading until it is known to be ours.
	if !hmac.Equal(p[offMAC:], mac(secret, uid, p[:offMAC])) {
		return Claims{}, ErrBadMAC
	}
	exp := time.Unix(int64(binary.BigEndian.Uint64(p[offExpiry:])), 0)
	if !now.Before(exp) || exp.After(now.Add(TTL+skew)) {
		return Claims{}, ErrExpired
	}
	return claimsOf(p, password)
}

// parse splits a bind password into its decoded payload and the real password,
// and checks the payload's structure: every unused byte zero, every presence
// byte 0 or 1, a known family, a CN no longer than its field.
func parse(s string) ([]byte, string, error) {
	rest, ok := strings.CutPrefix(s, Prefix)
	if !ok {
		return nil, "", ErrNoToken
	}
	encoded, password, ok := strings.Cut(rest, ".")
	// ⚠ ONE SPELLING ONLY. Go's base64 decoder skips CR and LF, so a length check
	// on the decoded size alone let `\r` into a token that still verified (found
	// by FuzzUnwrap). The exact encoded length and the URL alphabet, nothing else.
	if !ok || len(encoded) != base64.RawURLEncoding.EncodedLen(payloadLen) ||
		strings.TrimLeft(encoded, urlAlphabet) != "" {
		return nil, "", ErrMalformed
	}
	p, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(p) != payloadLen {
		return nil, "", ErrMalformed
	}
	if err := checkStructure(p); err != nil {
		return nil, "", err
	}
	return p, password, nil
}

// checkStructure is the one-encoding rule: every byte a field does not use is
// zero, every presence byte is 0 or 1, the family is known, and the CN fits its
// field. It reads nothing secret, so it may run before the MAC.
func checkStructure(p []byte) error {
	zero := func(b []byte) bool { return bytes.Count(b, []byte{0}) == len(b) }
	switch p[offFamily] {
	case family4:
		if !zero(p[offAddr+4 : offAddr+16]) {
			return ErrMalformed
		}
	case family6:
	default:
		return ErrMalformed
	}
	cnLen := int(p[offCNLen])
	if p[offKeyHas] > 1 || p[offDevHas] > 1 || cnLen > MaxCNLen ||
		(p[offKeyHas] == 0 && (!zero(p[offKey:offKey+CertKeyLen]) || cnLen != 0)) ||
		!zero(p[offCN+cnLen:offCN+MaxCNLen]) ||
		(p[offDevHas] == 0 && !zero(p[offDev:offDev+idLen])) ||
		!zero(p[offReserved:offMAC]) {
		return ErrMalformed
	}
	return nil
}

// claimsOf reads a structurally sound payload and enforces the mode partition
// against the real password.
func claimsOf(p []byte, password string) (Claims, error) {
	c := Claims{Password: password, Mode: Mode(p[offMode]), Attest: Attest{Protocol: Protocol(p[offProto])}}
	if c.Protocol != IMAP && c.Protocol != SMTP {
		return Claims{}, ErrMalformed
	}
	switch p[offFamily] {
	case family4:
		c.Addr = netip.AddrFrom4([4]byte(p[offAddr : offAddr+4]))
	case family6:
		c.Addr = netip.AddrFrom16([16]byte(p[offAddr : offAddr+16]))
		if c.Addr.Is4In6() {
			// One spelling: an IPv4 client is family 4.
			return Claims{}, ErrMalformed
		}
	default:
		return Claims{}, ErrMalformed
	}
	hasKey, hasDevice := p[offKeyHas] == 1, p[offDevHas] == 1
	if hasKey {
		c.CertKey = bytes.Clone(p[offKey : offKey+CertKeyLen])
		c.CertCN = string(p[offCN : offCN+int(p[offCNLen])])
	}
	if hasDevice {
		c.DeviceID = devicecode.IDText([idLen]byte(p[offDev : offDev+idLen]))
	}
	if hasKey && c.Protocol != IMAP {
		return Claims{}, ErrMode
	}
	switch c.Mode {
	case ModePassword:
		if password == "" || devicecode.HasReservedPrefix(password) || hasKey || hasDevice {
			return Claims{}, ErrMode
		}
	case ModeDeviceCode:
		if !devicecode.HasReservedPrefix(password) {
			return Claims{}, ErrMode
		}
		// The device is the one the password names, read by the parser authd's
		// device lane and the front both use, or none for a code that does not
		// parse (authd refuses that one as malformed).
		if c.DeviceID != devicecode.DeviceID(password) {
			return Claims{}, ErrMode
		}
	case ModeExternal:
		if password != "" || c.Protocol != IMAP || !hasKey || !hasDevice {
			return Claims{}, ErrMode
		}
	default:
		return Claims{}, ErrMalformed
	}
	return c, nil
}

func mac(secret []byte, uid string, payload []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(label))
	var n [2]byte
	binary.BigEndian.PutUint16(n[:], uint16(len(uid))) // at most maxUIDLen
	m.Write(n[:])
	m.Write([]byte(uid))
	m.Write(payload)
	return m.Sum(nil)
}
