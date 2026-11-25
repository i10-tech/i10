package bindtoken

import (
	"bytes"
	"encoding/base64"
	"errors"
	"net/netip"
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

	imap4   = Attest{Protocol: IMAP, Addr: netip.MustParseAddr("203.0.113.7")}
	smtp6   = Attest{Protocol: SMTP, Addr: netip.MustParseAddr("2001:db8::42")}
	macKey  = bytes.Repeat([]byte{0xa5}, CertKeyLen)
	macCert = Attest{Protocol: IMAP, Addr: netip.MustParseAddr("203.0.113.7"), CertKey: macKey, CertCN: "C02XYZ123"}
	devA    = "0a1b2c3d-0000-4000-8000-00000000004f"
)

func wrap(t *testing.T, k Key, uid, password string, at time.Time) string {
	t.Helper()
	s, err := Wrap(k, uid, password, imap4, at)
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
	c, err := Unwrap(both, "user_alice", s, now.Add(TTL-time.Second))
	if err != nil || c.Password != "right horse" || c.DeviceID != "" || c.Mode != ModePassword {
		t.Fatalf("Unwrap = %+v, %v", c, err)
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
		if _, err := Unwrap(c.keys, c.uid, s, c.at); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
}

// ⚠ No fallback: a raw password, whatever it looks like, is refused.
func TestARawPasswordIsNeverAccepted(t *testing.T) {
	enc := base64.RawURLEncoding.EncodedLen(payloadLen)
	for _, raw := range []string{"right horse", "", "i10mf3", "i10mf3.", "i10mf3.x.y", Prefix + strings.Repeat("A", enc) + ".pw"} {
		if c, err := Unwrap(both, "user_alice", raw, now); err == nil {
			t.Fatalf("Unwrap(%q) = %+v, accepted", raw, c)
		}
	}
}

func TestEveryBitOfThePayloadIsCovered(t *testing.T) {
	for name, s := range map[string]string{
		"password": wrap(t, key7, "user_alice", "pw", now),
		"external": mustExternal(t, now),
	} {
		enc, rest, _ := strings.Cut(strings.TrimPrefix(s, Prefix), ".")
		raw, _ := base64.RawURLEncoding.DecodeString(enc)
		for i := range raw {
			for _, bit := range []byte{1, 0x80} {
				m := bytes.Clone(raw)
				m[i] ^= bit
				forged := Prefix + base64.RawURLEncoding.EncodeToString(m) + "." + rest
				if _, err := Unwrap(both, "user_alice", forged, now); err == nil {
					t.Fatalf("%s: byte %d bit %#x flipped, still accepted", name, i, bit)
				}
			}
		}
	}
}

// One spelling only: base64 decoders skip CR and LF, and a token must not.
func TestATokenHasOneSpelling(t *testing.T) {
	s := wrap(t, key7, "user_alice", "pw", now)
	for _, insert := range []string{"\r", "\n", "=", " "} {
		forged := Prefix + insert + strings.TrimPrefix(s, Prefix)
		if _, err := Unwrap(both, "user_alice", forged, now); !errors.Is(err, ErrMalformed) {
			t.Errorf("%q inserted: %v, want ErrMalformed", insert, err)
		}
	}
}

// A token whose expiry lies far beyond its minute was not made by a front with
// a sane clock, even with the right key.
func TestAnExpiryTooFarAheadIsRefused(t *testing.T) {
	s, err := wrapWith(key7, "user_alice", Claims{Password: "pw", Mode: ModePassword, Attest: imap4}, now.Add(TTL+time.Minute), [nonceLen]byte{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Unwrap(both, "user_alice", s, now); !errors.Is(err, ErrExpired) {
		t.Fatalf("%v, want ErrExpired", err)
	}
}

func TestTheRealPasswordKeepsItsDotsAndPrefixes(t *testing.T) {
	for _, pw := range []string{"a.b.c", Prefix + "looks.like.one", " spaced ", "ünïcödé"} {
		s := wrap(t, key8, "user_alice", pw, now)
		if c, err := Unwrap(both, "user_alice", s, now); err != nil || c.Password != pw {
			t.Fatalf("%q: Unwrap = %q, %v", pw, c.Password, err)
		}
	}
	// Exactly one layer comes off: a token inside the password stays the password.
	inner := wrap(t, key8, "user_alice", "pw", now)
	outer := wrap(t, key8, "user_alice", inner, now)
	if c, err := Unwrap(both, "user_alice", outer, now); err != nil || c.Password != inner {
		t.Fatalf("Unwrap = %q, %v; want the inner string untouched", c.Password, err)
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
	if c, err := Unwrap(both, "user_alice", forA, now); err != nil || c.Password != codeA ||
		c.DeviceID != devicecode.DeviceID(codeA) || c.DeviceID == "" || c.Mode != ModeDeviceCode {
		t.Fatalf("Unwrap = %+v, %v", c, err)
	}
	forPlain := wrap(t, key7, "user_alice", "right horse", now)
	for name, tc := range map[string]struct {
		forged string
		want   error
	}{
		"device A's token behind device B's code":   {swap(forA, codeA, codeB), ErrMode},
		"device A's token behind a password":        {swap(forA, codeA, "right horse"), ErrMode},
		"a password's token behind device A's code": {swap(forPlain, "right horse", codeA), ErrMode},
	} {
		if _, err := Unwrap(both, "user_alice", tc.forged, now); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}
}

// ⚠ A MALFORMED CODE TRAVELS IN device_code MODE WITH NO DEVICE: authd's device
// lane refuses it as malformed, under the throttle, and it never reaches the
// password lane, whose providers must not see an i10dc password.
func TestAMalformedCodeIsADeviceCodeWithNoDevice(t *testing.T) {
	for _, bad := range []string{deviceCode(1)[:devicecode.Len-1], "i10dc", "i10dc-junk", deviceCode(1) + "\n"} {
		s := wrap(t, key7, "user_alice", bad, now)
		c, err := Unwrap(both, "user_alice", s, now)
		if err != nil || c.Mode != ModeDeviceCode || c.DeviceID != "" || c.Password != bad {
			t.Fatalf("%q: Unwrap = %+v, %v; want device_code with no device", bad, c, err)
		}
	}
}

// Every claim the front attests comes back exactly, in every mode.
func TestEveryClaimRoundTrips(t *testing.T) {
	ext := mustExternal(t, now)
	c, err := Unwrap(both, "user_alice", ext, now)
	if err != nil || c.Mode != ModeExternal || c.Password != "" || c.DeviceID != devA || c.Protocol != IMAP ||
		c.Addr != macCert.Addr || !bytes.Equal(c.CertKey, macKey) || c.CertCN != macCert.CertCN {
		t.Fatalf("external: %+v, %v", c, err)
	}
	code := deviceCode(3)
	s, err := Wrap(key7, "user_alice", code, macCert, now)
	if err != nil {
		t.Fatal(err)
	}
	if c, err := Unwrap(both, "user_alice", s, now); err != nil || c.Mode != ModeDeviceCode || !bytes.Equal(c.CertKey, macKey) ||
		c.CertCN != macCert.CertCN || c.DeviceID != devicecode.DeviceID(code) {
		t.Fatalf("an IMAP code with a certificate: %+v, %v", c, err)
	}
	s, err = Wrap(key7, "user_alice", code, smtp6, now)
	if err != nil {
		t.Fatal(err)
	}
	if c, err := Unwrap(both, "user_alice", s, now); err != nil || c.Protocol != SMTP || c.Addr != smtp6.Addr || c.CertKey != nil || c.CertCN != "" {
		t.Fatalf("an SMTP code over IPv6: %+v, %v", c, err)
	}
	full := strings.Repeat("x", MaxCNLen)
	at := macCert
	at.CertCN = full
	if s, err := Wrap(key7, "user_alice", code, at, now); err != nil {
		t.Fatal(err)
	} else if c, err := Unwrap(both, "user_alice", s, now); err != nil || c.CertCN != full {
		t.Fatalf("a 64-byte CN: %q, %v", c.CertCN, err)
	}
}

func mustExternal(t *testing.T, at time.Time) string {
	t.Helper()
	s, err := WrapExternal(key7, "user_alice", devA, macCert, at)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(s, ".") {
		t.Fatalf("an external token ends %q: there is no password behind it", s[len(s)-3:])
	}
	return s
}

// The front never mints what authd would refuse.
func TestWrapRefusesClaimsAVerifierWouldRefuse(t *testing.T) {
	code := deviceCode(1)
	smtpKey := macCert
	smtpKey.Protocol = SMTP
	mapped := imap4
	mapped.Addr = netip.MustParseAddr("::ffff:203.0.113.7")
	zoned := imap4
	zoned.Addr = netip.MustParseAddr("fe80::1%eth0")
	short := macCert
	short.CertKey = macKey[:31]
	long := macCert
	long.CertCN = strings.Repeat("x", MaxCNLen+1)
	cnOnly := imap4
	cnOnly.CertCN = "C02XYZ123"
	noProto := imap4
	noProto.Protocol = 0
	for name, mint := range map[string]func() (string, error){
		"an empty password":               func() (string, error) { return Wrap(key7, "user_alice", "", imap4, now) },
		"a certificate key on a password": func() (string, error) { return Wrap(key7, "user_alice", "pw", macCert, now) },
		"a certificate key on SMTP":       func() (string, error) { return Wrap(key7, "user_alice", code, smtpKey, now) },
		"an IPv4-mapped IPv6 address":     func() (string, error) { return Wrap(key7, "user_alice", "pw", mapped, now) },
		"an address with a zone":          func() (string, error) { return Wrap(key7, "user_alice", "pw", zoned, now) },
		"no address":                      func() (string, error) { return Wrap(key7, "user_alice", "pw", Attest{Protocol: IMAP}, now) },
		"no protocol":                     func() (string, error) { return Wrap(key7, "user_alice", "pw", noProto, now) },
		"a 31-byte key":                   func() (string, error) { return Wrap(key7, "user_alice", code, short, now) },
		"a CN of 65 bytes":                func() (string, error) { return Wrap(key7, "user_alice", code, long, now) },
		"a CN with no key":                func() (string, error) { return Wrap(key7, "user_alice", code, cnOnly, now) },
		"external with no key":            func() (string, error) { return WrapExternal(key7, "user_alice", devA, imap4, now) },
		"external on SMTP":                func() (string, error) { return WrapExternal(key7, "user_alice", devA, smtpKey, now) },
		"external with no device":         func() (string, error) { return WrapExternal(key7, "user_alice", "", macCert, now) },
		"external with a device not UUID": func() (string, error) { return WrapExternal(key7, "user_alice", "D-1", macCert, now) },
		"external with an uppercase UUID": func() (string, error) { return WrapExternal(key7, "user_alice", strings.ToUpper(devA), macCert, now) },
		"no signing key":                  func() (string, error) { return Wrap(Key{ID: 1}, "user_alice", "pw", imap4, now) },
		"an over-long user id":            func() (string, error) { return Wrap(key7, strings.Repeat("u", maxUIDLen+1), "pw", imap4, now) },
	} {
		if s, err := mint(); err == nil {
			t.Errorf("%s: minted %q", name, s)
		}
	}
}

// forge re-signs a token's payload after edit, with the right key: what a front
// with a bug would send. Unwrap must refuse it on its claims alone.
func forge(t *testing.T, token string, password string, edit func(p []byte)) string {
	t.Helper()
	enc, _, _ := strings.Cut(strings.TrimPrefix(token, Prefix), ".")
	p, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		t.Fatal(err)
	}
	edit(p)
	copy(p[offMAC:], mac(key7.Secret, "user_alice", p[:offMAC]))
	return Prefix + base64.RawURLEncoding.EncodeToString(p) + "." + password
}

// ⚠ THE MODE PARTITION, EACH RULE WITH A VALID MAC: a token for one mode never
// opens behind another's password, a key never rides on SMTP, and every unused
// byte is zero.
func TestUnwrapEnforcesThePartitionEvenWithAValidMAC(t *testing.T) {
	code := deviceCode(1)
	pw := wrap(t, key7, "user_alice", "pw", now)
	cd, _ := Wrap(key7, "user_alice", code, macCert, now)
	ext := mustExternal(t, now)
	setDevice := func(p []byte) { p[offDevHas] = 1; p[offDev] = 9 }
	setKey := func(p []byte) { p[offKeyHas] = 1; p[offKey] = 9 }
	cases := map[string]struct {
		token, password string
		edit            func(p []byte)
		want            error
	}{
		"password mode with a device":       {pw, "pw", setDevice, ErrMode},
		"password mode with a key":          {pw, "pw", setKey, ErrMode},
		"password mode behind a code":       {pw, code, func([]byte) {}, ErrMode},
		"password mode behind nothing":      {pw, "", func([]byte) {}, ErrMode},
		"password mode behind i10dc junk":   {pw, "i10dc-x", func([]byte) {}, ErrMode},
		"device_code behind a password":     {cd, "pw", func(p []byte) { p[offDevHas], p[offDev] = 0, 0; clear(p[offDev : offDev+idLen]) }, ErrMode},
		"device_code with no device":        {cd, code, func(p []byte) { p[offDevHas] = 0; clear(p[offDev : offDev+idLen]) }, ErrMode},
		"device_code naming another device": {cd, code, func(p []byte) { p[offDev+15] ^= 1 }, ErrMode},
		"a malformed code with a device":    {cd, code[:10], func([]byte) {}, ErrMode},
		"a key on SMTP":                     {cd, code, func(p []byte) { p[offProto] = byte(SMTP) }, ErrMode},
		"external behind a password":        {ext, "pw", func([]byte) {}, ErrMode},
		"external on SMTP": {ext, "", func(p []byte) {
			p[offProto] = byte(SMTP)
			p[offKeyHas] = 0
			clear(p[offKey : offKey+CertKeyLen])
			p[offCNLen] = 0
			clear(p[offCN : offCN+MaxCNLen])
		}, ErrMode},
		"external with no key": {ext, "", func(p []byte) {
			p[offKeyHas] = 0
			clear(p[offKey : offKey+CertKeyLen])
			p[offCNLen] = 0
			clear(p[offCN : offCN+MaxCNLen])
		}, ErrMode},
		"external with no device":       {ext, "", func(p []byte) { p[offDevHas] = 0; clear(p[offDev : offDev+idLen]) }, ErrMode},
		"an unknown mode":               {pw, "pw", func(p []byte) { p[offMode] = 4 }, ErrMalformed},
		"mode zero":                     {pw, "pw", func(p []byte) { p[offMode] = 0 }, ErrMalformed},
		"an unknown protocol":           {pw, "pw", func(p []byte) { p[offProto] = 3 }, ErrMalformed},
		"protocol zero":                 {pw, "pw", func(p []byte) { p[offProto] = 0 }, ErrMalformed},
		"an unknown family":             {pw, "pw", func(p []byte) { p[offFamily] = 5 }, ErrMalformed},
		"IPv4 with bytes past its four": {pw, "pw", func(p []byte) { p[offAddr+4] = 1 }, ErrMalformed},
		"IPv4-mapped IPv6": {pw, "pw", func(p []byte) {
			p[offFamily] = family6
			copy(p[offAddr:], netip.MustParseAddr("::ffff:1.2.3.4").AsSlice())
		}, ErrMalformed},
		"key bytes with no key":       {pw, "pw", func(p []byte) { p[offKey] = 1 }, ErrMalformed},
		"a CN with no key":            {pw, "pw", func(p []byte) { p[offCNLen] = 1; p[offCN] = 'x' }, ErrMalformed},
		"a CN longer than its field":  {cd, code, func(p []byte) { p[offCNLen] = MaxCNLen + 1 }, ErrMalformed},
		"bytes past the CN":           {cd, code, func(p []byte) { p[offCN+MaxCNLen-1] = 'x' }, ErrMalformed},
		"device bytes with no device": {pw, "pw", func(p []byte) { p[offDev] = 1 }, ErrMalformed},
		"a reserved byte":             {pw, "pw", func(p []byte) { p[offReserved+3] = 1 }, ErrMalformed},
		"a presence byte of 2":        {pw, "pw", func(p []byte) { p[offKeyHas] = 2 }, ErrMalformed},
	}
	for name, tc := range cases {
		if _, err := Unwrap(both, "user_alice", forge(t, tc.token, tc.password, tc.edit), now); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}
	// The forge itself is sound: unedited, each opens.
	for name, tc := range map[string][2]string{"password": {pw, "pw"}, "code": {cd, code}, "external": {ext, ""}} {
		if _, err := Unwrap(both, "user_alice", forge(t, tc[0], tc[1], func([]byte) {}), now); err != nil {
			t.Errorf("%s re-signed unedited: %v", name, err)
		}
	}
}

// v1 and v2 tokens had another layout and label. The front and authd switch
// together, so authd refuses them as it refuses a raw password.
func TestOlderTokensAreRefused(t *testing.T) {
	v3 := wrap(t, key7, "user_alice", "pw", now)
	for _, prefix := range []string{"i10mf1.", "i10mf2."} {
		old := prefix + strings.TrimPrefix(v3, Prefix)
		if _, err := Unwrap(both, "user_alice", old, now); !errors.Is(err, ErrNoToken) {
			t.Fatalf("a %s token: %v, want ErrNoToken", prefix, err)
		}
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
}

// FuzzUnwrap: whatever a client manages to get into the password, nothing
// without the key's MAC is accepted, nothing panics, and what is accepted
// claims exactly what a seed's key minted, in a mode its password fits.
func FuzzUnwrap(f *testing.F) {
	// Built with a fixed nonce: every fuzz worker runs this again and must get
	// the same tokens.
	nonce := [nonceLen]byte{1, 2, 3}
	exp := now.Add(TTL)
	mint := func(c Claims) string {
		s, err := wrapWith(key7, "user_alice", c, exp, nonce)
		if err != nil {
			f.Fatal(err)
		}
		return s
	}
	code := deviceCode(1)
	seeds := []struct {
		token, password string
		c               Claims
	}{
		{c: Claims{Password: "pw", Mode: ModePassword, Attest: imap4}},
		{c: Claims{Password: code, Mode: ModeDeviceCode, Attest: macCert, DeviceID: devicecode.DeviceID(code)}},
		{c: Claims{Password: devicecode.ReservedPrefix + "-junk", Mode: ModeDeviceCode, Attest: smtp6}},
		{c: Claims{Mode: ModeExternal, Attest: macCert, DeviceID: devA}},
	}
	for i := range seeds {
		seeds[i].password = seeds[i].c.Password
		seeds[i].token = strings.TrimSuffix(mint(seeds[i].c), seeds[i].password)
		f.Add(seeds[i].token + seeds[i].password)
	}
	f.Add("right horse")
	f.Add(Prefix + ".")
	f.Add(Prefix + strings.Repeat("A", base64.RawURLEncoding.EncodedLen(payloadLen)) + ".")
	f.Add(seeds[0].token + code)
	f.Add(seeds[3].token + "x")
	f.Fuzz(func(t *testing.T, s string) {
		got, err := Unwrap(both, "user_alice", s, now)
		if err != nil {
			return
		}
		for _, seed := range seeds {
			if !strings.HasPrefix(s, seed.token) {
				continue
			}
			want := seed.c
			if got.Password != strings.TrimPrefix(s, seed.token) || got.Mode != want.Mode || got.Protocol != want.Protocol ||
				got.Addr != want.Addr || !bytes.Equal(got.CertKey, want.CertKey) || got.CertCN != want.CertCN {
				t.Fatalf("Unwrap(%q) = %+v, but its token was minted for %+v", s, got, want)
			}
			// The token does not cover the password beyond its mode and device:
			// what follows may change only within the partition.
			pw, dev := got.Password, got.DeviceID
			switch got.Mode {
			case ModePassword:
				if pw == "" || devicecode.HasReservedPrefix(pw) || dev != "" {
					t.Fatalf("password mode accepted %q, device %q", pw, dev)
				}
			case ModeDeviceCode:
				if !devicecode.HasReservedPrefix(pw) || dev != want.DeviceID || dev != devicecode.DeviceID(pw) {
					t.Fatalf("device_code accepted %q for device %q, minted for %q", pw, dev, want.DeviceID)
				}
			case ModeExternal:
				if pw != "" || dev != want.DeviceID {
					t.Fatalf("external accepted %q for device %q", pw, dev)
				}
			}
			return
		}
		t.Fatalf("Unwrap(%q) = %+v accepted, and its token is not one the key made", s, got)
	})
}
