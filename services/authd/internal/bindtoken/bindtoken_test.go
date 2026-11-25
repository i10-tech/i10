package bindtoken

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
)

var (
	now   = time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	key7  = Key{ID: 7, Secret: bytes.Repeat([]byte{7}, 32)}
	key8  = Key{ID: 8, Secret: bytes.Repeat([]byte{8}, 32)}
	both  = Keys{7: key7.Secret, 8: key8.Secret}
	only8 = Keys{8: key8.Secret}
)

func wrap(t *testing.T, k Key, uid, password string, at time.Time) string {
	t.Helper()
	s, err := Wrap(k, uid, password, at)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestATokenOpensOnlyForItsAccountAndItsMinute(t *testing.T) {
	s := wrap(t, key7, "user_alice", "right horse", now)
	if !strings.HasPrefix(s, Prefix) || !strings.HasSuffix(s, ".right horse") {
		t.Fatalf("token %q", s)
	}
	if got, dev, err := Unwrap(both, "user_alice", s, now.Add(TTL-time.Second)); err != nil || got != "right horse" || dev != "" {
		t.Fatalf("Unwrap = %q, %v", got, err)
	}
	for name, c := range map[string]struct {
		keys Keys
		uid  string
		at   time.Time
		want error
	}{
		"another account":      {both, "user_bob", now, ErrBadMAC},
		"a key no longer kept": {only8, "user_alice", now, ErrUnknownKey},
		"no keys at all":       {Keys{}, "user_alice", now, ErrNoKeys},
		"after its minute":     {both, "user_alice", now.Add(TTL), ErrExpired},
		"an empty user id":     {both, "", now, ErrMalformed},
	} {
		if _, _, err := Unwrap(c.keys, c.uid, s, c.at); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
}

// ⚠ No fallback: a raw password, whatever it looks like, is refused.
func TestARawPasswordIsNeverAccepted(t *testing.T) {
	for _, raw := range []string{"right horse", "", "i10mf2", "i10mf2.", "i10mf2.x.y", Prefix + strings.Repeat("A", 76) + ".pw"} {
		if got, _, err := Unwrap(both, "user_alice", raw, now); err == nil {
			t.Fatalf("Unwrap(%q) = %q, accepted", raw, got)
		}
	}
}

func TestEveryBitOfThePayloadIsCovered(t *testing.T) {
	s := wrap(t, key7, "user_alice", "pw", now)
	enc, rest, _ := strings.Cut(strings.TrimPrefix(s, Prefix), ".")
	raw, _ := base64.RawURLEncoding.DecodeString(enc)
	for i := range raw {
		for _, bit := range []byte{1, 0x80} {
			m := bytes.Clone(raw)
			m[i] ^= bit
			forged := Prefix + base64.RawURLEncoding.EncodeToString(m) + "." + rest
			if _, _, err := Unwrap(both, "user_alice", forged, now); err == nil {
				t.Fatalf("byte %d bit %#x flipped, still accepted", i, bit)
			}
		}
	}
}

// One spelling only: base64 decoders skip CR and LF, and a token must not.
func TestATokenHasOneSpelling(t *testing.T) {
	s := wrap(t, key7, "user_alice", "pw", now)
	for _, insert := range []string{"\r", "\n", "=", " "} {
		forged := Prefix + insert + strings.TrimPrefix(s, Prefix)
		if _, _, err := Unwrap(both, "user_alice", forged, now); !errors.Is(err, ErrMalformed) {
			t.Errorf("%q inserted: %v, want ErrMalformed", insert, err)
		}
	}
}

// A token whose expiry lies far beyond its minute was not made by a front with
// a sane clock, even with the right key.
func TestAnExpiryTooFarAheadIsRefused(t *testing.T) {
	s := wrapWith(key7, "user_alice", "pw", now.Add(TTL+time.Minute), [nonceLen]byte{})
	if _, _, err := Unwrap(both, "user_alice", s, now); !errors.Is(err, ErrExpired) {
		t.Fatalf("%v, want ErrExpired", err)
	}
}

func TestTheRealPasswordKeepsItsDotsAndPrefixes(t *testing.T) {
	for _, pw := range []string{"a.b.c", Prefix + "looks.like.one", " spaced ", "ünïcödé"} {
		s := wrap(t, key8, "user_alice", pw, now)
		if got, _, err := Unwrap(both, "user_alice", s, now); err != nil || got != pw {
			t.Fatalf("%q: Unwrap = %q, %v", pw, got, err)
		}
	}
	// Exactly one layer comes off: a token inside the password stays the password.
	inner := wrap(t, key8, "user_alice", "pw", now)
	outer := wrap(t, key8, "user_alice", inner, now)
	if got, _, err := Unwrap(both, "user_alice", outer, now); err != nil || got != inner {
		t.Fatalf("Unwrap = %q, %v; want the inner string untouched", got, err)
	}
	if _, _, err := Unwrap(both, "user_alice", wrap(t, key8, "user_alice", "", now), now); !errors.Is(err, ErrMalformed) {
		t.Fatalf("an empty real password: %v", err)
	}
}

// deviceCode is a well-formed device code for id byte b.
func deviceCode(b byte) string {
	var id [16]byte
	var secret [32]byte
	id[0], secret[0] = b, b
	return devicecode.New(id, secret).String()
}

// ⚠ THE TOKEN BINDS THE DEVICE. A token minted in front of one device's code
// opens only in front of that code: not another device's, not an ordinary
// password, and a token minted in front of an ordinary password does not open in
// front of a device code. So the device the front credits and the one authd
// verifies cannot differ.
func TestATokenOpensOnlyForTheDeviceItWasMintedFor(t *testing.T) {
	codeA, codeB := deviceCode(1), deviceCode(2)
	swap := func(token, from, to string) string { return strings.TrimSuffix(token, from) + to }

	forA := wrap(t, key7, "user_alice", codeA, now)
	if got, dev, err := Unwrap(both, "user_alice", forA, now); err != nil || got != codeA || dev != devicecode.DeviceID(codeA) || dev == "" {
		t.Fatalf("Unwrap = %q, device %q, %v", got, dev, err)
	}
	forPlain := wrap(t, key7, "user_alice", "right horse", now)
	for name, forged := range map[string]string{
		"device A's token behind device B's code":   swap(forA, codeA, codeB),
		"device A's token behind a password":        swap(forA, codeA, "right horse"),
		"a password's token behind device A's code": swap(forPlain, "right horse", codeA),
	} {
		if _, _, err := Unwrap(both, "user_alice", forged, now); !errors.Is(err, ErrBadMAC) {
			t.Errorf("%s: %v, want ErrBadMAC", name, err)
		}
	}
	// A malformed code names no device on either side; authd's device lane
	// refuses it after the token is off.
	bad := codeA[:len(codeA)-1]
	if got, dev, err := Unwrap(both, "user_alice", wrap(t, key7, "user_alice", bad, now), now); err != nil || got != bad || dev != "" {
		t.Fatalf("a malformed code behind its own token: %q, device %q, %v", got, dev, err)
	}
}

// v1 tokens carried no device. The front and authd switch together, so authd
// refuses one as it refuses a raw password: there is nothing to accept it for.
func TestAVersionOneTokenIsRefused(t *testing.T) {
	v2 := wrap(t, key7, "user_alice", "pw", now)
	v1 := "i10mf1." + strings.TrimPrefix(v2, Prefix)
	if _, _, err := Unwrap(both, "user_alice", v1, now); !errors.Is(err, ErrNoToken) {
		t.Fatalf("a v1 token: %v, want ErrNoToken", err)
	}
}

func TestKeysParse(t *testing.T) {
	good := "7:" + base64.StdEncoding.EncodeToString(key7.Secret) + ", 8:" + base64.RawURLEncoding.EncodeToString(key8.Secret)
	ks, err := ParseKeys(good)
	if err != nil || len(ks) != 2 || !bytes.Equal(ks[7], key7.Secret) || !bytes.Equal(ks[8], key8.Secret) {
		t.Fatalf("ParseKeys = %v, %v", ks, err)
	}
	if ks, err := ParseKeys(""); err != nil || len(ks) != 0 {
		t.Fatalf("empty = %v, %v", ks, err)
	}
	short := base64.StdEncoding.EncodeToString(make([]byte, 31))
	for _, bad := range []string{"7", "x:" + short, "256:" + base64.StdEncoding.EncodeToString(key7.Secret), "7:" + short, "7:!!!", good + ",7:" + base64.StdEncoding.EncodeToString(key8.Secret)} {
		if _, err := ParseKeys(bad); err == nil {
			t.Errorf("ParseKeys(%q) accepted", bad)
		}
	}
	if _, err := Wrap(Key{ID: 1}, "user_alice", "pw", now); err == nil {
		t.Error("Wrap with no secret")
	}
	if _, err := Wrap(key7, strings.Repeat("u", maxUIDLen+1), "pw", now); err == nil {
		t.Error("Wrap with an over-long user id")
	}
}

// FuzzUnwrap: whatever a client manages to get into the password, nothing
// without the key's MAC is accepted, and nothing panics.
func FuzzUnwrap(f *testing.F) {
	// Built with a fixed nonce: every fuzz worker runs this again and must get
	// the same token.
	valid := wrapWith(key7, "user_alice", "pw", now.Add(TTL), [nonceLen]byte{1, 2, 3})
	f.Add(valid)
	f.Add("right horse")
	f.Add(Prefix + ".")
	f.Add(Prefix + strings.Repeat("A", 76) + ".")
	f.Add(strings.TrimSuffix(valid, "pw") + deviceCode(1))
	f.Fuzz(func(t *testing.T, s string) {
		got, dev, err := Unwrap(both, "user_alice", s, now)
		if err != nil {
			return
		}
		// The token does not cover the password (authd checks that with the
		// provider), so what follows it may be anything but a device code: the
		// token was minted in front of "pw", which names no device. The token part
		// may not change at all.
		token := strings.TrimSuffix(valid, "pw")
		if !strings.HasPrefix(s, token) || got != strings.TrimPrefix(s, token) || got == "" {
			t.Fatalf("Unwrap(%q) = %q accepted, and its token is not the one the key made", s, got)
		}
		if dev != "" || devicecode.DeviceID(got) != "" {
			t.Fatalf("Unwrap(%q) accepted device %q behind a token minted for none", s, dev)
		}
	})
}
