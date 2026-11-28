package enrolltoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"math"
	"time"
)

// Mac ACME path tokens.
//
// ⚠ THE ACME DIRECTORY URL IN A SEALED MAC PROFILE CARRIES A SECRET ONLY THAT
// MAC HAS. The profile is CMS-encrypted to the device's SCEP key, so the URL
//
//	https://<acme host>/acme/apple/d/<token>/directory
//
// is the Mac's capability to create ACME orders. A Mac serial is not a secret,
// so a gate on the serial alone let anyone who knew one fill Redis with orders
// and spent nonces, and exhaust the real Mac's order cap. acmed verifies the
// token on every request before it touches Redis.
//
//	token = base64url( kid(1) || device_id(16) || exp_be32(4) || serial(n) ||
//	                   HMAC-SHA256(K[kid], label || kid || device_id || serial || exp)[:16] )
//
// The serial is carried in the token (after the fixed fields, 1 to
// ACMEPathMaxSerialLen characters of [A-Za-z0-9_-]) so acmed can verify the MAC
// on every request, including the directory and new-nonce, without a lookup.
//
// The key ring is ENROLL_ACME_PATH_KEYS, held by enrollctl (signs) and acmed
// (verifies). A path key mints nothing: forging a token only opens order
// creation for a serial, and finalize still needs Apple's attestation of that
// serial and the OU permit only enrollctl signs.
const (
	// ACMEPathSegment is the path element between the ACME prefix and a token.
	ACMEPathSegment = "/d/"
	// ACMEPathLifetime is the Mac's ACME window after its Phase 4 seal.
	ACMEPathLifetime = 10 * time.Minute
	// ACMEPathMaxSerialLen bounds the serial a token carries.
	ACMEPathMaxSerialLen = 64

	acmePathLabel  = "i10/acme-path/v1\x00"
	acmePathFixed  = 1 + 16 + 4
	acmePathMACLen = 16
	acmePathMinRaw = acmePathFixed + 1 + acmePathMACLen
	acmePathMaxRaw = acmePathFixed + ACMEPathMaxSerialLen + acmePathMACLen
)

// ACMEPathMaxLen is the longest base64url token SignACMEPath produces.
var ACMEPathMaxLen = base64.RawURLEncoding.EncodedLen(acmePathMaxRaw)

// ACMEPathClaims is a verified path token.
type ACMEPathClaims struct {
	DeviceIDBytes [16]byte
	DeviceID      string
	Serial        string
	ExpiresAt     time.Time
}

// SignACMEPath makes the path token for a Mac's ACME directory URL.
func SignACMEPath(ring *Ring, deviceID [16]byte, serial string, exp time.Time) (string, error) {
	if !validACMEPathSerial(serial) {
		return "", errors.New("enrolltoken: ACME path serial is not 1..64 characters of [A-Za-z0-9_-]")
	}
	key, err := ring.signingKey()
	if err != nil {
		return "", err
	}
	expSec := exp.UTC().Unix()
	if expSec <= 0 || expSec > math.MaxUint32 {
		return "", errors.New("enrolltoken: ACME path expiry out of uint32 range")
	}
	raw := make([]byte, 0, acmePathFixed+len(serial)+acmePathMACLen)
	raw = append(raw, key.ID)
	raw = append(raw, deviceID[:]...)
	raw = binary.BigEndian.AppendUint32(raw, uint32(expSec))
	raw = append(raw, serial...)
	raw = append(raw, computeACMEPathMAC(key.Secret, key.ID, deviceID[:], serial, raw[17:21])...)
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// VerifyACMEPath checks a path token's encoding, key id, MAC and expiry. It
// needs nothing but the ring.
func VerifyACMEPath(ring *Ring, token string, now time.Time) (ACMEPathClaims, error) {
	if ring == nil || len(ring.byID) == 0 || len(token) > ACMEPathMaxLen {
		return ACMEPathClaims{}, ErrInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) < acmePathMinRaw || len(raw) > acmePathMaxRaw ||
		base64.RawURLEncoding.EncodeToString(raw) != token {
		return ACMEPathClaims{}, ErrInvalid
	}
	secret, ok := ring.byID[raw[0]]
	if !ok {
		return ACMEPathClaims{}, ErrInvalid
	}
	serial := string(raw[acmePathFixed : len(raw)-acmePathMACLen])
	if !validACMEPathSerial(serial) {
		return ACMEPathClaims{}, ErrInvalid
	}
	want := computeACMEPathMAC(secret, raw[0], raw[1:17], serial, raw[17:21])
	if !hmac.Equal(raw[len(raw)-acmePathMACLen:], want) {
		return ACMEPathClaims{}, ErrInvalid
	}
	expSec := int64(binary.BigEndian.Uint32(raw[17:21]))
	if expSec == 0 {
		return ACMEPathClaims{}, ErrInvalid
	}
	if now.UTC().Unix() >= expSec {
		return ACMEPathClaims{}, ErrExpired
	}
	var dev [16]byte
	copy(dev[:], raw[1:17])
	return ACMEPathClaims{
		DeviceIDBytes: dev,
		DeviceID:      FormatUUID(dev),
		Serial:        serial,
		ExpiresAt:     time.Unix(expSec, 0).UTC(),
	}, nil
}

func computeACMEPathMAC(secret []byte, kid byte, deviceID []byte, serial string, exp []byte) []byte {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(acmePathLabel))
	m.Write([]byte{kid})
	m.Write(deviceID)
	m.Write([]byte(serial))
	m.Write(exp)
	return m.Sum(nil)[:acmePathMACLen]
}

func validACMEPathSerial(s string) bool {
	if len(s) == 0 || len(s) > ACMEPathMaxSerialLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
