package mailfront

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
)

// TestLiveProbe runs the review rounds' attacks against a live Stalwart (v1.1.0
// first, v1.2.0 on 2026-11-23: every subtest passed on both) with authd (this
// branch) as its LDAP directory and the front in front of it
// (docs/research/mail-device-binding.md section 9, "The bind token, probed").
// It is skipped unless MAILFRONT_LIVE_PROBE=1, and runs inside Stalwart's
// network namespace, where Stalwart's own loopback listeners can be reached:
//
//	MAILFRONT_LIVE_PROBE=1 MFP_FRONT=<pod ip> MFP_BIND_KEY=<id:base64> ./mailfront.test -test.run TestLiveProbe -test.v
//
// Accounts: alice@i10.test (user_alice) and bob@i10.test (user_bob), both
// with the password "right horse".
func TestLiveProbe(t *testing.T) {
	if os.Getenv("MAILFRONT_LIVE_PROBE") != "1" {
		t.Skip("MAILFRONT_LIVE_PROBE is not 1")
	}
	front := os.Getenv("MFP_FRONT")
	key, err := bindtoken.ParseKey(os.Getenv("MFP_BIND_KEY"))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("an ordinary sign-in through the front", func(t *testing.T) {
		c := liveIMAP(t, front+":993")
		c.cmd("a0 CAPABILITY", "a0 OK")
		c.cmd("a1 LOGIN alice@i10.test \"right horse\"", "a1 OK")
		c.cmd("a2 SELECT INBOX", "a2 OK")
		msg := "Subject: probe\r\n\r\nhello there\r\n"
		c.cmd(fmt.Sprintf("a3 APPEND INBOX {%d+}\r\n%s", len(msg), msg), "a3 OK")
		c.cmd("a4 FETCH 1 (FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)])", "a4 OK")
		c.cmd("a5 IDLE", "+ ")
		c.cmd("DONE", "a5 OK")
		c.cmd("a6 LOGOUT", "a6 OK")
	})

	t.Run("an ordinary SMTP submission through the front", func(t *testing.T) {
		c := liveSMTP(t, front+":465")
		c.cmd("EHLO probe.i10.test", "250 ")
		c.cmd("AUTH LOGIN", "334")
		c.cmd(b64("alice@i10.test"), "334")
		c.cmd(b64("right horse"), "235")
		c.cmd("MAIL FROM:<alice@i10.test>", "250")
		c.cmd("RCPT TO:<bob@i10.test>", "250")
		c.cmd("DATA", "354")
		c.cmd("Subject: probe\r\n\r\nhello\r\n.", "250")
		c.cmd("QUIT", "221")
	})

	// Round 3: Stalwart echoes a forged literal marker raw, the output scanner
	// reads 100 MB as a literal, and a second LOGIN passes it unseen. With the
	// token it reaches authd raw and is refused.
	t.Run("round 3: a forged literal, then UNAUTHENTICATE and LOGIN as bob", func(t *testing.T) {
		c := liveIMAP(t, front+":993")
		c.cmd("a1 LOGIN alice@i10.test \"right horse\"", "a1 OK")
		// The reviewer's bytes, pipelined in one write (/tmp/mf-r3/repro/capture.py).
		lit := "x {99999999}\r\n"
		c.send(fmt.Sprintf("b SELECT INBOX\r\nc SEARCH BEFORE {%d+}\r\n%s\r\nd UNAUTHENTICATE\r\ne LOGIN bob@i10.test \"right horse\"\r\nf NOOP\r\n", len(lit), lit))
		c.expect("c BAD")
		c.expect("d OK")
		c.expect("e NO")
	})

	// The same bytes with Stalwart's recovery admin as the second sign-in, as
	// the reviewer ran them. It is checked by Stalwart alone, never by authd, so
	// the token cannot stop it: the operator's root credential, outside the
	// design (services/authd/README.md). Recorded, not asserted either way.
	t.Run("round 3 with the recovery admin, outside the token design", func(t *testing.T) {
		admin := os.Getenv("MFP_RECOVERY_ADMIN")
		if admin == "" {
			t.Skip("MFP_RECOVERY_ADMIN not set")
		}
		user, pw, _ := strings.Cut(admin, ":")
		c := liveIMAP(t, front+":993")
		c.cmd("a1 LOGIN alice@i10.test \"right horse\"", "a1 OK")
		lit := "x {99999999}\r\n"
		c.send(fmt.Sprintf("b SELECT INBOX\r\nc SEARCH BEFORE {%d+}\r\n%s\r\nd UNAUTHENTICATE\r\ne LOGIN %s %s\r\nf NOOP\r\n", len(lit), lit, user, pw))
		c.expect("c BAD")
		c.expect("d OK")
		c.expectAny()
	})

	// Round 2: Stalwart echoes `*` and `+` as tags on a sign-in.
	for _, tag := range []string{"*", "+"} {
		t.Run("round 2: a second sign-in under the tag "+tag, func(t *testing.T) {
			c := liveIMAP(t, front+":993")
			c.cmd("a1 LOGIN alice@i10.test \"right horse\"", "a1 OK")
			c.cmd(tag+" UNAUTHENTICATE", tag+" OK")
			c.cmd(tag+" LOGIN bob@i10.test \"right horse\"", tag+" NO")
		})
	}

	// Round 1: to Stalwart `x{N}` is a word, so the N bytes after it are a second
	// command. The front refuses the ambiguous line before anything reaches
	// Stalwart.
	t.Run("round 1: a literal Stalwart reads as a word", func(t *testing.T) {
		hidden := "T LOGIN bob@i10.test \"right horse\"\r\n"
		c := liveIMAP(t, front+":993")
		c.send(fmt.Sprintf("a NOOP x{%d}\r\n", len(hidden)))
		c.send(hidden)
		c.send("T LOGIN alice@i10.test \"right horse\"\r\n")
		c.expectClosed()
	})

	// Without the front, straight to Stalwart's loopback listener with a PROXY
	// header: a raw password is refused by authd, and only the front's token
	// for the right account signs in.
	probeAt := bindtoken.Attest{Protocol: bindtoken.IMAP, Addr: netip.MustParseAddr("203.0.113.7")}
	t.Run("straight to Stalwart: raw, another account's token, the right token", func(t *testing.T) {
		raw := liveStalwart(t, "127.0.0.1:993", true)
		raw.cmd("a1 LOGIN alice@i10.test \"right horse\"", "a1 NO")
		bobs, _ := bindtoken.Wrap(key, "user_bob", "right horse", probeAt, time.Now())
		raw.cmd(fmt.Sprintf("a2 LOGIN alice@i10.test {%d+}\r\n%s", len(bobs), bobs), "a2 NO")
		alices, _ := bindtoken.Wrap(key, "user_alice", "right horse", probeAt, time.Now())
		raw.cmd(fmt.Sprintf("a3 LOGIN alice@i10.test {%d+}\r\n%s", len(alices), alices), "a3 OK")
	})

	t.Run("SMTP through the front: one AUTH, a second refused", func(t *testing.T) {
		c := liveSMTP(t, front+":465")
		c.cmd("EHLO probe.i10.test", "250 ")
		c.cmd("AUTH PLAIN "+plain("", "alice@i10.test", "right horse"), "235")
		c.cmd("AUTH PLAIN "+plain("", "bob@i10.test", "right horse"), "503")
	})

	// What Stalwart itself offers on its loopback listeners, for the bearer
	// defence in depth. The front strips these from what clients see.
	t.Run("Stalwart's own mechanisms, with the SSL TLV", func(t *testing.T) {
		c := liveStalwart(t, "127.0.0.1:993", true)
		c.cmd("a1 CAPABILITY", "a1 OK")
		s := liveStalwart(t, "127.0.0.1:465", true)
		s.cmd("EHLO probe.i10.test", "250 ")
		s.cmd("AUTH XOAUTH2 "+b64("user=alice@i10.test\x01auth=Bearer x\x01\x01"), "")
		s.cmd("AUTH OAUTHBEARER "+b64("n,a=alice@i10.test,\x01auth=Bearer x\x01\x01"), "")
	})
	t.Run("Stalwart's own mechanisms, without the SSL TLV", func(t *testing.T) {
		c := liveStalwart(t, "127.0.0.1:993", false)
		c.cmd("a1 CAPABILITY", "a1 OK")
		alices, _ := bindtoken.Wrap(key, "user_alice", "right horse", probeAt, time.Now())
		c.cmd(fmt.Sprintf("a2 LOGIN alice@i10.test {%d+}\r\n%s", len(alices), alices), "a2 ")
		c2 := liveStalwart(t, "127.0.0.1:993", false)
		plainTok, _ := bindtoken.Wrap(key, "user_alice", "right horse", probeAt, time.Now())
		c2.cmd("b1 AUTHENTICATE PLAIN "+plain("", "alice@i10.test", plainTok), "b1 ")
		c3 := liveStalwart(t, "127.0.0.1:993", false)
		c3.cmd("x1 AUTHENTICATE XOAUTH2 "+b64("user=alice@i10.test\x01auth=Bearer x\x01\x01"), "x1 ")
		c4 := liveStalwart(t, "127.0.0.1:993", false)
		c4.cmd("o1 AUTHENTICATE OAUTHBEARER "+b64("n,a=alice@i10.test,\x01auth=Bearer x\x01\x01"), "o1 ")
	})
}

// liveConn is one probe connection that logs every line both ways.
type liveConn struct {
	t *testing.T
	c net.Conn
	r *bufio.Reader
}

func liveIMAP(t *testing.T, addr string) *liveConn {
	c := liveTLS(t, addr)
	c.expect("* OK")
	return c
}

func liveSMTP(t *testing.T, addr string) *liveConn {
	c := liveTLS(t, addr)
	c.expect("220")
	return c
}

func liveTLS(t *testing.T, addr string) *liveConn {
	t.Helper()
	conn, err := tls.Dial("tcp", addr, &tls.Config{InsecureSkipVerify: true, ServerName: "mail.i10.test"})
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	return &liveConn{t: t, c: conn, r: bufio.NewReader(conn)}
}

// liveStalwart connects to one of Stalwart's loopback listeners the way the
// front does: a PROXY v2 header first, with or without the SSL TLV.
func liveStalwart(t *testing.T, addr string, sslTLV bool) *liveConn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 3*time.Second)
	if err != nil {
		t.Fatalf("dial %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	src := &net.TCPAddr{IP: net.ParseIP("203.0.113.7"), Port: 40000}
	_, port, _ := net.SplitHostPort(addr)
	var dport int
	fmt.Sscanf(port, "%d", &dport)
	dst := &net.TCPAddr{IP: net.ParseIP("192.0.2.1"), Port: dport}
	var ssl *tls.ConnectionState
	if sslTLV {
		ssl = &tls.ConnectionState{Version: tls.VersionTLS13}
	}
	hdr := proxyHeader(src, dst, ssl)
	if _, err := conn.Write(hdr); err != nil {
		t.Fatal(err)
	}
	c := &liveConn{t: t, c: conn, r: bufio.NewReader(conn)}
	if dport == 465 {
		c.expect("220")
	} else {
		c.expect("* OK")
	}
	return c
}

func (c *liveConn) send(s string) {
	c.t.Helper()
	for _, l := range strings.Split(strings.TrimSuffix(s, "\r\n"), "\r\n") {
		c.t.Logf("C: %s", redact(l))
	}
	if _, err := c.c.Write([]byte(s)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// cmd sends one line and reads until a line starting with want, or fails on
// a line that ends the command otherwise.
func (c *liveConn) cmd(line, want string) {
	c.t.Helper()
	c.send(line + "\r\n")
	c.expect(want)
}

func (c *liveConn) expect(want string) {
	c.t.Helper()
	for {
		l, err := c.r.ReadString('\n')
		if err != nil {
			c.t.Fatalf("waiting for %q: %v", want, err)
		}
		l = strings.TrimRight(l, "\r\n")
		if len(l) > 200 {
			l = l[:200] + "..."
		}
		c.t.Logf("S: %s", l)
		if strings.HasPrefix(l, want) {
			return
		}
	}
}

// expectAny logs whatever arrives until the connection ends or goes quiet.
func (c *liveConn) expectAny() {
	c.t.Helper()
	_ = c.c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		l, err := c.r.ReadString('\n')
		if l != "" {
			l = strings.TrimRight(l, "\r\n")
			if len(l) > 120 {
				l = l[:120] + "..."
			}
			c.t.Logf("S: %s", l)
		}
		if err != nil {
			c.t.Logf("ended: %v", err)
			return
		}
	}
}

func (c *liveConn) expectClosed() {
	c.t.Helper()
	for {
		l, err := c.r.ReadString('\n')
		if l != "" {
			c.t.Logf("S: %s", strings.TrimRight(l, "\r\n"))
			if strings.Contains(l, " OK [CAPABILITY") {
				c.t.Fatalf("signed in: %q", l)
			}
		}
		if err != nil {
			c.t.Logf("closed: %v", err)
			return
		}
	}
}

// redact keeps passwords and tokens out of the probe's log.
func redact(l string) string {
	if i := strings.Index(l, bindtoken.Prefix); i >= 0 {
		return l[:i] + bindtoken.Prefix + "<token+password>"
	}
	return strings.ReplaceAll(l, "right horse", "<password>")
}
