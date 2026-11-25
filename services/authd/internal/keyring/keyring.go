// Package keyring reads the HMAC key lists authd and the mail front are
// configured with: the bind token keys (internal/bindtoken) and the device code
// keys (internal/devicecode). Both are "<id>:<base64 secret>", comma-separated,
// so both are read by this one parser.
package keyring

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

// MinLen is the shortest secret accepted: an HMAC-SHA256 key shorter than its
// output is a key that can be guessed sooner than the MAC.
const MinLen = 32

// Key is one secret and its id.
type Key struct {
	ID     byte
	Secret []byte
}

// Ring is every key a verifier accepts, by id.
type Ring map[byte][]byte

// ParseKey reads one key as "<id>:<base64 secret>", id 0 to 255. what names the
// setting in errors.
func ParseKey(what, s string) (Key, error) {
	id, secret, ok := strings.Cut(strings.TrimSpace(s), ":")
	if !ok {
		return Key{}, fmt.Errorf("%s: a key is <id>:<base64 secret>", what)
	}
	n, err := strconv.ParseUint(id, 10, 8)
	if err != nil {
		// ⚠ NEVER QUOTE IT: a key written the wrong way round (`<secret>:<id>`)
		// would put the secret in the ERROR log.
		return Key{}, fmt.Errorf("%s: the key id (%d bytes) is not 0 to 255", what, len(id))
	}
	raw, err := base64.StdEncoding.DecodeString(secret)
	if err != nil {
		if raw, err = base64.RawURLEncoding.DecodeString(secret); err != nil {
			return Key{}, fmt.Errorf("%s: key %d is not base64", what, n)
		}
	}
	if len(raw) < MinLen {
		return Key{}, fmt.Errorf("%s: key %d is %d bytes, need at least %d", what, n, len(raw), MinLen)
	}
	return Key{ID: byte(n), Secret: raw}, nil
}

// ParseRing reads a comma-separated list of keys. Ids must be distinct. An empty
// string is an empty ring, not an error: what an empty ring means is the
// caller's to say.
func ParseRing(what, s string) (Ring, error) {
	ring := Ring{}
	for _, part := range strings.Split(s, ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		k, err := ParseKey(what, part)
		if err != nil {
			return nil, err
		}
		if _, dup := ring[k.ID]; dup {
			return nil, fmt.Errorf("%s: key id %d appears twice", what, k.ID)
		}
		ring[k.ID] = k.Secret
	}
	return ring, nil
}

// IDs lists the ring's key ids, for a startup log line. Never the secrets.
func (r Ring) IDs() []int {
	ids := make([]int, 0, len(r))
	for id := range r {
		ids = append(ids, int(id))
	}
	return ids
}
