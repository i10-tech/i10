package mailfront

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Device sessions in the front (#383): attributed to the device the bind token
// covered, closed when that device's row is gone or no longer matches, and
// ended at the device maximum age.

func testCode(b byte) devicecode.Code {
	var id [16]byte
	var secret [32]byte
	id[0], id[15], secret[0] = b, 0x7f, b
	return devicecode.New(id, secret)
}

// aliceDevice is the row the API would have minted for alice's iPhone.
func aliceDevice(c devicecode.Code) projection.Device {
	return projection.Device{ID: c.ID(), ClerkUserID: "user_alice", Email: "alice@i10.test", Platform: "ios"}
}

// grants is the Grant of every watched connection.
func grants(h *harness) []Grant {
	conns, _ := h.srv.reg.snapshot()
	out := make([]Grant, 0, len(conns))
	for _, c := range conns {
		out = append(out, c.grant)
	}
	return out
}

func TestADeviceSessionIsAttributedToTheDeviceItsTokenCovered(t *testing.T) {
	code := testCode(1)
	for _, proto := range []Protocol{IMAP, SMTP} {
		t.Run(proto.String(), func(t *testing.T) {
			h := startFront(t, proto, alice(), nil)
			c := h.dial()
			if proto == IMAP {
				c.until("* OK")
				c.send(`a LOGIN alice@i10.test "` + code.String() + `"` + "\r\n")
				if got := c.until("a "); !strings.HasPrefix(got, "a OK") {
					t.Fatalf("LOGIN answered %q", got)
				}
			} else {
				c.until("220")
				c.send("EHLO me\r\n")
				c.until("250 ")
				c.send("AUTH LOGIN " + b64("alice@i10.test") + "\r\n")
				c.until("334")
				c.send(b64(code.String()) + "\r\n")
				if got := c.until(""); !strings.HasPrefix(got, "235") {
					t.Fatalf("AUTH answered %q", got)
				}
			}
			waitFor(t, "the session to be watched", func() bool { return h.srv.Live() == 1 })
			g := grants(h)[0]
			h.upstream.mu.Lock()
			covered := append([]string(nil), h.upstream.devicesFor...)
			h.upstream.mu.Unlock()
			if g.DeviceID != code.ID() || len(covered) != 1 || covered[0] != code.ID() {
				t.Fatalf("the grant credits device %q, the token covered %v; want both %s", g.DeviceID, covered, code.ID())
			}
			if left := time.Until(g.Until); left < DeviceMaxAge-time.Minute || left > DeviceMaxAge+DeviceMaxAgeJitter {
				t.Fatalf("a device session ends in %s, want between %s and %s", left, DeviceMaxAge, DeviceMaxAge+DeviceMaxAgeJitter)
			}
		})
	}
}

// ⚠ ONE DEVICE PER ATTEMPT. A device code refused, then the right password: the
// session that signed in is a password session, not the refused device's. And
// the other way round.
func TestAnEarlierAttemptsDeviceIsNeverCreditedToTheSignIn(t *testing.T) {
	code := testCode(2)
	t.Run("code refused, then the password", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), nil)
		h.upstream.mu.Lock()
		h.upstream.refuseDevices = true
		h.upstream.mu.Unlock()
		c := h.dial()
		c.until("* OK")
		c.send(`a LOGIN alice@i10.test "` + code.String() + `"` + "\r\n")
		if got := c.until("a "); !strings.HasPrefix(got, "a NO") {
			t.Fatalf("the refused code answered %q", got)
		}
		c.send(`b LOGIN alice@i10.test "right horse"` + "\r\n")
		if got := c.until("b "); !strings.HasPrefix(got, "b OK") {
			t.Fatalf("the password answered %q", got)
		}
		waitFor(t, "the session to be watched", func() bool { return h.srv.Live() == 1 })
		if g := grants(h)[0]; g.DeviceID != "" || !g.Until.IsZero() {
			t.Fatalf("a password session credited to device %q (until %v)", g.DeviceID, g.Until)
		}
	})
	t.Run("password refused, then the code", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), nil)
		c := h.dial()
		c.until("* OK")
		c.send(`a LOGIN alice@i10.test "wrong horse"` + "\r\n")
		c.until("a NO")
		c.send(`b LOGIN alice@i10.test "` + code.String() + `"` + "\r\n")
		if got := c.until("b "); !strings.HasPrefix(got, "b OK") {
			t.Fatalf("the code answered %q", got)
		}
		waitFor(t, "the session to be watched", func() bool { return h.srv.Live() == 1 })
		if g := grants(h)[0]; g.DeviceID != code.ID() {
			t.Fatalf("the device session credited to %q", g.DeviceID)
		}
	})
}

// ⚠ A DEVICE REVOKED, OR NO LONGER MATCHING, CLOSES ITS SESSION AT THE NEXT POLL,
// not the backstop, and leaves the person's other sessions alone.
func TestADeviceSessionClosesWhenItsRowGoesOrStopsMatching(t *testing.T) {
	code, other := testCode(3), testCode(4)
	cases := map[string]struct {
		change func(f *fakeAccounts)
		reason string
	}{
		"revoked": {func(f *fakeAccounts) { f.deleteDevice(code.ID()) }, gate.DeviceRevoked},
		"moved to another person": {func(f *fakeAccounts) {
			d := aliceDevice(code)
			d.ClerkUserID = "user_bob"
			f.addDevice(d)
			f.logChange(projection.ChangeAccount, "user_alice")
		}, gate.DeviceRevoked},
		"minted for an address alice no longer has": {func(f *fakeAccounts) {
			d := aliceDevice(code)
			d.Email = "old@i10.test"
			f.addDevice(d)
		}, gate.DeviceMismatch},
		"another workspace": {func(f *fakeAccounts) {
			d := aliceDevice(code)
			d.TenantID = "t-other"
			f.addDevice(d)
		}, gate.DeviceMismatch},
		"turned into a Mac": {func(f *fakeAccounts) {
			d := aliceDevice(code)
			d.Platform = "macos"
			f.addDevice(d)
		}, gate.DevicePlatformRefused},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			logs := &lockedBuffer{}
			accts := alice()
			accts.addDevice(aliceDevice(code))
			accts.addDevice(aliceDevice(other))
			h := startFront(t, IMAP, accts, func(s *Server) { s.Log = slog.New(slog.NewTextHandler(logs, nil)) })
			signIn := func(pw string) *client {
				c := h.dial()
				c.until("* OK")
				c.send(`a LOGIN alice@i10.test "` + pw + `"` + "\r\n")
				c.until("a OK")
				return c
			}
			mine, theirs, password := signIn(code.String()), signIn(other.String()), signIn("right horse")
			waitFor(t, "three sessions", func() bool { return h.srv.Live() == 3 })
			mine.send("b IDLE\r\n")
			mine.until("+ idling")
			if st := h.sweeper.Poll(context.Background()); st.Closed != 0 || st.Err != nil {
				t.Fatalf("the first poll %+v, want the new sessions re-checked and kept", st)
			}

			tc.change(accts)
			st := h.sweeper.Poll(context.Background())
			if st.Full || st.Closed != 1 {
				t.Fatalf("poll %+v, want exactly the device's session closed by the change-driven poll", st)
			}
			if !mine.closed(time.Second) {
				t.Fatal("the device session is still open")
			}
			waitFor(t, "the close reason "+tc.reason, func() bool { return strings.Contains(logs.String(), "reason="+tc.reason) })
			for _, c := range []*client{theirs, password} {
				c.send("n NOOP\r\n")
				c.until("n OK")
			}
		})
	}
}

// Everything that closes an account's sessions closes its device sessions too.
func TestAnAccountRevocationClosesItsDeviceSessions(t *testing.T) {
	code := testCode(5)
	accts := alice()
	accts.addDevice(aliceDevice(code))
	h := startFront(t, IMAP, accts, nil)
	c := h.dial()
	c.until("* OK")
	c.send(`a LOGIN alice@i10.test "` + code.String() + `"` + "\r\n")
	c.until("a OK")
	waitFor(t, "the session", func() bool { return h.srv.Live() == 1 })
	h.sweeper.Poll(context.Background())
	accts.update("alice@i10.test", func(a *projection.Account) { a.PaymentHold = true })
	if st := h.sweeper.Poll(context.Background()); st.Closed != 1 {
		t.Fatalf("poll %+v, want the device session closed", st)
	}
}

// ⚠ A device session ends at the device maximum age, never at the pass-through
// one, even on a managed account, and the clock rule holds with the database
// down.
func TestADeviceSessionEndsAtTheDeviceMaxAge(t *testing.T) {
	managed := account("user_alice", "alice@i10.test")
	managed.Managed, managed.ManagedConnection = true, "conn-1"
	soon, later := time.Now().Add(time.Minute), time.Now().Add(50*time.Millisecond)
	g, reason := admit(&managed, "d-1", nil, sessionEnds{passthrough: soon, device: later})
	if reason != "" || g.Until != later || g.DeviceID != "d-1" {
		t.Fatalf("admit = %+v, %q; want the device max age", g, reason)
	}
	r := newPollRig(t, managed)
	r.accounts.failAll = true
	r.register(g)
	time.Sleep(60 * time.Millisecond)
	if st := r.poll(); st.Closed != 1 || r.closed["user_alice"] != ReasonDeviceMaxAge {
		t.Fatalf("poll %+v closed %v, want the device session closed for %s", st, r.closed, ReasonDeviceMaxAge)
	}
}

func TestDeviceSessionsEndWithinTheirJitter(t *testing.T) {
	at := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	lo, hi := 48*time.Hour, time.Duration(0)
	for range 2000 {
		d := deviceUntil(at).Sub(at)
		if d < DeviceMaxAge || d >= DeviceMaxAge+DeviceMaxAgeJitter {
			t.Fatalf("until %s, want in [%s, %s)", d, DeviceMaxAge, DeviceMaxAge+DeviceMaxAgeJitter)
		}
		lo, hi = min(lo, d), max(hi, d)
	}
	if hi-lo < DeviceMaxAgeJitter/2 {
		t.Fatalf("2000 sessions ended within %s of each other: not spread", hi-lo)
	}
}
