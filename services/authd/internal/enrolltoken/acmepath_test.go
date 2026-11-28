package enrolltoken

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestACMEPathRoundTripAndRefusals(t *testing.T) {
	ring, err := ParseNonEmptyRing("path", "4:"+base64.StdEncoding.EncodeToString([]byte(strings.Repeat("p", 32)))+
		",5:"+base64.StdEncoding.EncodeToString([]byte(strings.Repeat("q", 32))))
	if err != nil {
		t.Fatal(err)
	}
	other, _ := ParseNonEmptyRing("other", "4:"+base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32))))
	now := time.Unix(1_800_000_000, 0).UTC()
	dev, _ := NewUUIDv7At(now)
	tok, err := SignACMEPath(ring, dev, "C02PATH0001", now.Add(ACMEPathLifetime))
	if err != nil {
		t.Fatal(err)
	}
	c, err := VerifyACMEPath(ring, tok, now)
	if err != nil || c.DeviceIDBytes != dev || c.Serial != "C02PATH0001" || !c.ExpiresAt.Equal(now.Add(ACMEPathLifetime)) {
		t.Fatalf("round trip = (%+v, %v)", c, err)
	}
	if long, err := SignACMEPath(ring, dev, strings.Repeat("Z", ACMEPathMaxSerialLen), now.Add(time.Minute)); err != nil || len(long) != ACMEPathMaxLen {
		t.Fatalf("longest serial = (%d chars, %v), want %d", len(long), err, ACMEPathMaxLen)
	}

	raw, _ := base64.RawURLEncoding.DecodeString(tok)
	edit := func(f func(b []byte) []byte) string {
		return base64.RawURLEncoding.EncodeToString(f(append([]byte{}, raw...)))
	}
	flip := func(i int) string { return edit(func(b []byte) []byte { b[i] ^= 1; return b }) }
	otherSerial := edit(func(b []byte) []byte { b[acmePathFixed] = 'D'; return b })
	for name, tc := range map[string]struct {
		tok  string
		at   time.Time
		want error
	}{
		"flipped MAC":       {flip(len(raw) - 1), now, ErrInvalid},
		"another device":    {flip(5), now, ErrInvalid},
		"another expiry":    {flip(20), now, ErrInvalid},
		"another serial":    {otherSerial, now, ErrInvalid},
		"unknown key id":    {flip(0), now, ErrInvalid},
		"another ring":      {mustSign(t, other, dev, "C02PATH0001", now.Add(time.Minute)), now, ErrInvalid},
		"expired":           {tok, now.Add(ACMEPathLifetime), ErrExpired},
		"truncated":         {tok[:len(tok)-2], now, ErrInvalid},
		"no serial":         {edit(func(b []byte) []byte { return append(b[:acmePathFixed], b[len(b)-acmePathMACLen:]...) }), now, ErrInvalid},
		"bad serial byte":   {edit(func(b []byte) []byte { b[acmePathFixed] = '/'; return b }), now, ErrInvalid},
		"bad alphabet":      {strings.Repeat("+", 40), now, ErrInvalid},
		"too long":          {tok + strings.Repeat("A", ACMEPathMaxLen), now, ErrInvalid},
		"empty":             {"", now, ErrInvalid},
		"non-canonical end": {tok[:len(tok)-1] + nudgeLast(tok), now, ErrInvalid},
	} {
		if _, err := VerifyACMEPath(ring, tc.tok, tc.at); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
	for _, bad := range []string{"", "C02/x", strings.Repeat("Z", ACMEPathMaxSerialLen+1)} {
		if _, err := SignACMEPath(ring, dev, bad, now.Add(time.Minute)); err == nil {
			t.Errorf("SignACMEPath accepted serial %q", bad)
		}
	}
}

func mustSign(t *testing.T, r *Ring, dev [16]byte, serial string, exp time.Time) string {
	t.Helper()
	s, err := SignACMEPath(r, dev, serial, exp)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// nudgeLast changes only bits of the last character that no byte uses, when
// there are any; otherwise it changes a used bit (still a refusal).
func nudgeLast(tok string) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	i := strings.IndexByte(alphabet, tok[len(tok)-1])
	return string(alphabet[i^1])
}
