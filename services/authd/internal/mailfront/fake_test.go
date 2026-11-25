package mailfront

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// ── the projection ───────────────────────────────────────────────────────────

// fakeAccounts is the projection: accounts by their primary address.
type fakeAccounts struct {
	mu      sync.Mutex
	byLogin map[string]*projection.Account
	failAll bool
	sweeps  int
	// changes is the access-change log; a snapshot is how many rows it held.
	changes     []projection.Change
	serverStart time.Time
	polls       int
	// devices are the `authd.mail_devices` rows, by id.
	devices map[string]projection.Device
}

func newFakeAccounts(accts ...projection.Account) *fakeAccounts {
	f := &fakeAccounts{
		byLogin:     map[string]*projection.Account{},
		serverStart: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC),
	}
	for i := range accts {
		a := accts[i]
		f.byLogin[a.Email] = &a
	}
	return f
}

func (f *fakeAccounts) AccountByLogin(_ context.Context, login string) (*projection.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAll {
		return nil, errors.New("projection unreachable")
	}
	a, ok := f.byLogin[normaliseLogin(login)]
	if !ok || !a.Active {
		return nil, nil
	}
	cp := *a
	return &cp, nil
}

func (f *fakeAccounts) AccountsByUIDs(_ context.Context, ids, deviceIDs []string) ([]projection.Account, time.Duration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sweeps++
	if f.failAll {
		return nil, 0, errors.New("projection unreachable")
	}
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	var out []projection.Account
	for _, a := range f.byLogin {
		if want[a.ClerkUserID] && a.Active {
			cp := *a
			cp.Devices = nil
			for _, id := range deviceIDs {
				if d, ok := f.devices[id]; ok && d.ClerkUserID == a.ClerkUserID {
					cp.Devices = append(cp.Devices, d)
				}
			}
			out = append(out, cp)
		}
	}
	return out, 0, nil
}

// addDevice puts a device row in, as the API's store function would.
func (f *fakeAccounts) addDevice(d projection.Device) {
	f.mu.Lock()
	if f.devices == nil {
		f.devices = map[string]projection.Device{}
	}
	f.devices[d.ID] = d
	f.changes = append(f.changes, projection.Change{Kind: projection.ChangeAccount, Key: d.ClerkUserID})
	f.mu.Unlock()
}

// deleteDevice is a revoke, logged as the table's trigger logs it.
func (f *fakeAccounts) deleteDevice(id string) {
	f.mu.Lock()
	d := f.devices[id]
	delete(f.devices, id)
	f.changes = append(f.changes, projection.Change{Kind: projection.ChangeAccount, Key: d.ClerkUserID})
	f.mu.Unlock()
}

func (f *fakeAccounts) AccessChanges(_ context.Context, since string, limit int) (projection.ChangeBatch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.polls++
	if f.failAll {
		return projection.ChangeBatch{}, errors.New("projection unreachable")
	}
	b := projection.ChangeBatch{Snapshot: strconv.Itoa(len(f.changes)), ServerStart: f.serverStart}
	if since == "" {
		return b, nil
	}
	from, _ := strconv.Atoi(since)
	if from > len(f.changes) {
		// The log is shorter than the position: the ids went back.
		b.Rewound = true
		return b, nil
	}
	b.Changes = append(b.Changes, f.changes[from:]...)
	if len(b.Changes) > limit {
		b.Changes, b.Truncated = b.Changes[:limit], true
	}
	return b, nil
}

// update changes the account with this primary address, as the API would, and
// logs it as the triggers would.
func (f *fakeAccounts) update(email string, fn func(*projection.Account)) {
	f.mu.Lock()
	a := f.byLogin[email]
	fn(a)
	f.changes = append(f.changes, projection.Change{Kind: projection.ChangeAccount, Key: a.ClerkUserID})
	f.mu.Unlock()
}

// silently changes the account without logging it: a write the log missed.
func (f *fakeAccounts) silently(email string, fn func(*projection.Account)) {
	f.mu.Lock()
	fn(f.byLogin[email])
	f.mu.Unlock()
}

// logChange appends a change to the log, as a trigger on another table would.
func (f *fakeAccounts) logChange(kind projection.ChangeKind, key string) {
	f.mu.Lock()
	f.changes = append(f.changes, projection.Change{Kind: kind, Key: key})
	f.mu.Unlock()
}

// uids is the account each login names, for the fake Stalwart's authd check.
func (f *fakeAccounts) uids() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]string{}
	for login, a := range f.byLogin {
		out[strings.ToLower(login)] = a.ClerkUserID
	}
	return out
}

func account(id, email string) projection.Account {
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	_, domain, _ := strings.Cut(email, "@")
	return projection.Account{ClerkUserID: id, Email: email, MailDomain: strings.ToLower(domain), Active: true,
		CredentialEpoch: 7, ClerkUpdatedAt: &at}
}

// ── a Stalwart that speaks just enough ───────────────────────────────────────

const rightPassword = "right horse"

// testBindKey is the front's bind token key in these tests, and the fake's.
var testBindKey = bindtoken.Key{ID: 3, Secret: []byte("fake-authd-key-0123456789abcdef!")}

// adminLogin is a login Stalwart itself accepts with a raw password, as it does
// its recovery admin, without asking authd.
const adminLogin = "admin"

// fakeStalwart is the upstream: it checks the PROXY header, then speaks a small
// IMAP or SMTP, reading commands by Stalwart's own rules
// (stalwart_rules_test.go). It signs a session in the way Stalwart with authd
// behind it does: only with a valid bind token for the account the login
// names, in front of rightPassword (adminLogin takes the raw password, as
// Stalwart's recovery admin does). It records what it hears with the token
// taken off, and which accounts the tokens it saw were for.
type fakeStalwart struct {
	ln    net.Listener
	proto Protocol

	mu        sync.Mutex
	uidOf     map[string]string // the account each login names, as authd's DN would say
	headers   [][]byte          // PROXY headers received
	heard     []string          // commands, as Stalwart's reader parsed them, without tags
	signedIn  []string
	conns     []net.Conn
	tokensFor []string // the account of every valid token, in order
	raw       int      // sign-ins whose password carried no valid token
	// devicesFor is the device every valid token covered, for a device code.
	devicesFor []string
	// refuseDevices makes authd's device lane refuse every code.
	refuseDevices bool
}

func startFakeStalwart(t *testing.T, proto Protocol) *fakeStalwart {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeStalwart{ln: ln, proto: proto}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			f.mu.Lock()
			f.conns = append(f.conns, c)
			f.mu.Unlock()
			go f.serve(c)
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, c := range f.conns {
			_ = c.Close()
		}
	})
	return f
}

func (f *fakeStalwart) addr() string { return f.ln.Addr().String() }

func (f *fakeStalwart) serve(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	head := make([]byte, 16)
	if _, err := io.ReadFull(r, head); err != nil || !bytes.Equal(head[:12], proxySignature) {
		return
	}
	rest := make([]byte, binary.BigEndian.Uint16(head[14:]))
	if _, err := io.ReadFull(r, rest); err != nil {
		return
	}
	f.mu.Lock()
	f.headers = append(f.headers, append(head, rest...))
	f.mu.Unlock()
	if f.proto == SMTP {
		f.smtp(c, r)
	} else {
		f.imap(c, r)
	}
}

// header is the i-th PROXY header received, or nil.
func (f *fakeStalwart) header(i int) []byte {
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		if i < len(f.headers) {
			h := f.headers[i]
			f.mu.Unlock()
			return h
		}
		f.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	return nil
}

func (f *fakeStalwart) record(s string) {
	f.mu.Lock()
	f.heard = append(f.heard, s)
	f.mu.Unlock()
}

// commands is everything the fake heard, in order.
func (f *fakeStalwart) commands() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.heard...)
}

// check is authd's part: the password behind a valid token for login's
// account, and whether the sign-in succeeds.
func (f *fakeStalwart) check(login, pass string) (string, bool) {
	if strings.EqualFold(login, adminLogin) {
		return pass, pass == rightPassword
	}
	f.mu.Lock()
	uid := f.uidOf[strings.ToLower(strings.TrimSpace(login))]
	f.mu.Unlock()
	pw, device, err := bindtoken.Unwrap(bindtoken.Keys{testBindKey.ID: testBindKey.Secret}, uid, pass, time.Now())
	f.mu.Lock()
	defer f.mu.Unlock()
	if err != nil {
		f.raw++
		return pass, false
	}
	f.tokensFor = append(f.tokensFor, uid)
	if device != "" {
		// authd's device lane, which is tested on its own (internal/ldapsrv):
		// here any well-formed code signs in, and the device the token covered
		// is recorded.
		f.devicesFor = append(f.devicesFor, device)
		return pw, !f.refuseDevices
	}
	return pw, pw == rightPassword
}

// checkPlain is check for a PLAIN response: the response with the token taken
// off, the authcid, and whether it signs in.
func (f *fakeStalwart) checkPlain(b64 string) (string, string, bool) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	parts := strings.SplitN(string(raw), "\x00", 3)
	if err != nil || len(parts) != 3 {
		return b64, "", false
	}
	pw, ok := f.check(parts[1], parts[2])
	return base64.StdEncoding.EncodeToString([]byte(parts[0] + "\x00" + parts[1] + "\x00" + pw)), parts[1], ok
}

// tokens is the account of every valid token seen, and how many sign-ins had none.
func (f *fakeStalwart) tokens() ([]string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.tokensFor...), f.raw
}

func (f *fakeStalwart) signIn(user string) {
	f.mu.Lock()
	f.signedIn = append(f.signedIn, user)
	f.mu.Unlock()
}

// signedInAs is every account the fake signed a session in as.
func (f *fakeStalwart) signedInAs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.signedIn...)
}

func (f *fakeStalwart) imap(c net.Conn, r *bufio.Reader) {
	fmt.Fprint(c, "* OK [CAPABILITY IMAP4rev2 SASL-IR LITERAL+ ID AUTH=PLAIN AUTH=OAUTHBEARER AUTH=XOAUTH2] ready\r\n")
	for {
		req, err := stalwartReadIMAP(r, func() { fmt.Fprint(c, "+ Ready for literal data\r\n") })
		if errors.Is(err, errStalwartParse) {
			// Stalwart answers and reads on from the next byte.
			fmt.Fprint(c, "* BAD [PARSE] Invalid command\r\n")
			continue
		}
		if err != nil {
			return
		}
		shown := make([]string, len(req.args))
		for i, a := range req.args {
			shown[i] = strings.ReplaceAll(a, stalNil, "NIL")
		}
		// authd's check, before anything is recorded, so the record shows the
		// password behind the token.
		loginOK, plainUser := false, ""
		switch {
		case req.command == "LOGIN" && len(req.args) == 2:
			shown[1], loginOK = f.check(req.args[0], req.args[1])
		case req.command == "AUTHENTICATE" && len(req.args) == 2 && strings.EqualFold(req.args[0], "PLAIN"):
			shown[1], plainUser, loginOK = f.checkPlain(req.args[1])
		}
		f.record(strings.TrimSpace(req.command + " " + strings.Join(shown, " ")))
		tag := req.tag
		switch req.command {
		case "CAPABILITY":
			fmt.Fprintf(c, "* CAPABILITY IMAP4rev2 AUTH=PLAIN AUTH=XOAUTH2 COMPRESS=DEFLATE\r\n%s OK done\r\n", tag)
		case "ID":
			fmt.Fprintf(c, "* ID NIL\r\n%s OK ID done\r\n", tag)
		case "LOGIN":
			if !loginOK {
				fmt.Fprintf(c, "%s NO wrong\r\n", tag)
				continue
			}
			if req.args[0] == "stray@i10.test" {
				// A tagged answer for a command the front never sent.
				fmt.Fprint(c, "zz NO stray answer\r\n")
			}
			if req.args[0] == "racer@i10.test" {
				// A tagged OK for a sign-in the front did not send, arriving while
				// its own is pending: what a hidden or racing LOGIN produces.
				fmt.Fprint(c, "zz OK [CAPABILITY IMAP4rev2] Authentication successful\r\n")
			}
			f.signIn(req.args[0])
			fmt.Fprintf(c, "%s OK [CAPABILITY IMAP4rev2 IDLE UNAUTHENTICATE] Authentication successful\r\n", tag)
		case "AUTHENTICATE":
			if len(req.args) == 0 || !strings.EqualFold(req.args[0], "PLAIN") {
				fmt.Fprintf(c, "%s BAD Unsupported mechanism\r\n", tag)
				continue
			}
			if len(req.args) == 1 {
				fmt.Fprint(c, "+ \r\n")
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				ir := strings.TrimRight(l, "\r\n")
				if ir == "*" {
					f.record("sasl:*")
				} else {
					var shownIR string
					shownIR, plainUser, loginOK = f.checkPlain(ir)
					f.record("sasl:" + shownIR)
				}
			}
			if loginOK {
				f.signIn(plainUser)
				fmt.Fprintf(c, "%s OK [CAPABILITY IMAP4rev2 IDLE] Authentication successful\r\n", tag)
			} else {
				fmt.Fprintf(c, "%s NO Authentication failed\r\n", tag)
			}
		case "XSIGNIN":
			// After sign-in: what UNAUTHENTICATE followed by LOGIN produces.
			fmt.Fprintf(c, "%s OK [CAPABILITY IMAP4rev2] Authentication successful\r\n", tag)
		case "UNAUTHENTICATE":
			fmt.Fprintf(c, "%s OK Unauthenticate successful.\r\n", tag)
		case "XFETCH":
			// A message whose text looks like a sign-in, inside a literal.
			body := "x OK [CAPABILITY IMAP4rev2] not a sign-in\r\n"
			fmt.Fprintf(c, "* 1 FETCH (BODY[] {%d}\r\n%s)\r\n%s OK FETCH done\r\n", len(body), body, tag)
		case "IDLE":
			fmt.Fprint(c, "+ idling\r\n")
			if _, err := r.ReadString('\n'); err != nil {
				return
			}
			fmt.Fprintf(c, "%s OK IDLE done\r\n", tag)
		case "LOGOUT":
			fmt.Fprintf(c, "* BYE bye\r\n%s OK LOGOUT done\r\n", tag)
			return
		default:
			fmt.Fprintf(c, "%s OK done\r\n", tag)
		}
	}
}

func (f *fakeStalwart) smtp(c net.Conn, r *bufio.Reader) {
	fmt.Fprint(c, "220 mail.test ready\r\n")
	authed := false
	readResp := func() (string, bool) {
		l, err := r.ReadString('\n')
		if err != nil {
			return "", false
		}
		return strings.TrimRight(l, "\r\n"), true
	}
	decode := func(s string) string { b, _ := base64.StdEncoding.DecodeString(s); return string(b) }
	for {
		l, err := r.ReadString('\n')
		if err != nil {
			return
		}
		verb, args, ok := stalwartSMTPVerb(l)
		if !ok {
			fmt.Fprint(c, "500 5.5.1 Invalid command.\r\n")
			continue
		}
		switch verb {
		case "EHLO":
			f.record(strings.TrimSpace(verb + " " + args))
			fmt.Fprint(c, "250-mail.test\r\n250-PIPELINING\r\n250-AUTH PLAIN LOGIN XOAUTH2 OAUTHBEARER\r\n250 8BITMIME\r\n")
		case "AUTH":
			if authed {
				f.record(strings.TrimSpace(verb + " " + args))
				fmt.Fprint(c, "503 5.5.1 Already authenticated.\r\n")
				continue
			}
			mech, ir, hasIR := strings.Cut(args, " ")
			signed := false
			switch strings.ToUpper(mech) {
			case "PLAIN":
				if hasIR {
					shown, _, ok := f.checkPlain(ir)
					f.record("AUTH PLAIN " + shown)
					signed = ok
				} else {
					f.record("AUTH PLAIN")
					fmt.Fprint(c, "334 \r\n")
					resp, ok := readResp()
					if !ok {
						return
					}
					if resp == "*" {
						f.record("sasl:*")
					} else {
						shown, _, ok := f.checkPlain(resp)
						f.record("sasl:" + shown)
						signed = ok
					}
				}
			case "LOGIN":
				user := ""
				if hasIR {
					f.record("AUTH LOGIN " + ir)
					user = decode(ir)
				} else {
					f.record("AUTH LOGIN")
					fmt.Fprint(c, "334 VXNlcm5hbWU6\r\n")
					resp, ok := readResp()
					if !ok {
						return
					}
					f.record("sasl:" + resp)
					user = decode(resp)
				}
				fmt.Fprint(c, "334 UGFzc3dvcmQ6\r\n")
				resp, ok := readResp()
				if !ok {
					return
				}
				if resp == "*" {
					f.record("sasl:*")
				} else {
					pw, ok := f.check(user, decode(resp))
					f.record("sasl:" + base64.StdEncoding.EncodeToString([]byte(pw)))
					signed = ok
				}
			default:
				f.record(strings.TrimSpace(verb + " " + args))
			}
			if signed {
				authed = true
				f.signIn("smtp")
				fmt.Fprint(c, "235 2.7.0 Authentication succeeded.\r\n")
			} else {
				fmt.Fprint(c, "535 5.7.8 nope\r\n")
			}
		case "XSIGNIN":
			f.record(verb)
			fmt.Fprint(c, "235 2.7.0 Authentication succeeded.\r\n")
		case "QUIT":
			f.record(verb)
			fmt.Fprint(c, "221 2.0.0 bye\r\n")
			return
		default:
			f.record(strings.TrimSpace(verb + " " + args))
			fmt.Fprint(c, "250 2.0.0 OK\r\n")
		}
	}
}

// ── the front under test ─────────────────────────────────────────────────────

type harness struct {
	t        *testing.T
	srv      *Server
	sweeper  *Sweeper
	accounts *fakeAccounts
	upstream *fakeStalwart
	addr     string
	roots    *x509.CertPool
}

func startFront(t *testing.T, proto Protocol, accounts *fakeAccounts, tune func(*Server)) *harness {
	t.Helper()
	up := startFakeStalwart(t, proto)
	up.mu.Lock()
	up.uidOf = accounts.uids()
	up.mu.Unlock()
	certs, roots := testCerts(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if testing.Verbose() {
		log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}
	srv := NewServer(accounts, TLSConfig(certs), log)
	srv.Limits.PreAuth = 5 * time.Second
	key := testBindKey
	srv.BindTokenKey = &key
	if tune != nil {
		tune(srv)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln, proto, up.addr()) }()
	t.Cleanup(func() {
		_ = ln.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	})
	return &harness{t: t, srv: srv, sweeper: srv.Sweeper(time.Second, time.Second), accounts: accounts,
		upstream: up, addr: ln.Addr().String(), roots: roots}
}

// client is one mail client connected to the front.
type client struct {
	t    *testing.T
	c    *tls.Conn
	r    *bufio.Reader
	tail strings.Builder // what closed read before the connection ended
}

func (h *harness) dial() *client {
	h.t.Helper()
	c, err := tls.Dial("tcp", h.addr, &tls.Config{RootCAs: h.roots, ServerName: "mail.i10.test"})
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { _ = c.Close() })
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	return &client{t: h.t, c: c, r: bufio.NewReader(c)}
}

func (c *client) send(s string) {
	c.t.Helper()
	if _, err := io.WriteString(c.c, s); err != nil {
		c.t.Fatalf("send %q: %v", s, err)
	}
}

// line reads one line, or "" with the connection closed.
func (c *client) line() string {
	l, err := c.r.ReadString('\n')
	if err != nil {
		return ""
	}
	return strings.TrimRight(l, "\r\n")
}

// until reads lines until one has the prefix, failing on a closed connection.
func (c *client) until(prefix string) string {
	c.t.Helper()
	for {
		l, err := c.r.ReadString('\n')
		if err != nil {
			c.t.Fatalf("waiting for %q: %v", prefix, err)
		}
		if strings.HasPrefix(l, prefix) {
			return strings.TrimRight(l, "\r\n")
		}
	}
}

// closed reports whether the front ends the connection within d. What it reads
// on the way is kept for seen.
func (c *client) closed(d time.Duration) bool {
	_ = c.c.SetReadDeadline(time.Now().Add(d))
	for {
		l, err := c.r.ReadString('\n')
		c.tail.WriteString(l)
		if err != nil {
			var ne net.Error
			return !(errors.As(err, &ne) && ne.Timeout())
		}
	}
}

// seen is what closed read.
func (c *client) seen() string { return c.tail.String() }

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func plain(authzid, user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(authzid + "\x00" + user + "\x00" + pass))
}

// ── certificates ─────────────────────────────────────────────────────────────

var (
	certOnce               sync.Once
	certPEM, keyPEM, caPEM []byte
	certErr                error
)

// testCerts is a CA and a leaf for mail.i10.test, made once per test binary and
// written to files the way the front loads them.
func testCerts(t *testing.T) (*CertFiles, *x509.CertPool) {
	t.Helper()
	certOnce.Do(func() { certPEM, keyPEM, caPEM, certErr = makeCerts() })
	if certErr != nil {
		t.Fatal(certErr)
	}
	dir := t.TempDir()
	cf := &CertFiles{CertFile: filepath.Join(dir, "tls.crt"), KeyFile: filepath.Join(dir, "tls.key")}
	if err := os.WriteFile(cf.CertFile, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cf.KeyFile, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cf.Load(); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(caPEM)
	return cf, roots
}

func makeCerts() (cert, key, ca []byte, err error) {
	caKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, nil, err
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "mailfront test CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, nil, err
	}
	leafKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, nil, err
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "mail.i10.test"},
		DNSNames:     []string{"mail.i10.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caTmpl, &leafKey.PublicKey, caKey)
	if err != nil {
		return nil, nil, nil, err
	}
	cert = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	key = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(leafKey)})
	ca = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	return cert, key, ca, nil
}
