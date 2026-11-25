package mailfront

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"log/slog"
	"math/big"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// testDeviceCA is a throwaway device CA + intermediate for client cert tests.
type testDeviceCA struct {
	rootKey  *ecdsa.PrivateKey
	rootCert *x509.Certificate
	rootPEM  []byte
	intKey   *ecdsa.PrivateKey
	intCert  *x509.Certificate
	intDER   []byte
}

func newTestDeviceCA(t *testing.T) *testDeviceCA {
	t.Helper()
	rk, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rt := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "i10 Device Test Root CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	rDER, err := x509.CreateCertificate(rand.Reader, rt, rt, &rk.PublicKey, rk)
	if err != nil {
		t.Fatal(err)
	}
	rc, err := x509.ParseCertificate(rDER)
	if err != nil {
		t.Fatal(err)
	}
	ik, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	it := &x509.Certificate{
		SerialNumber:          big.NewInt(2),
		Subject:               pkix.Name{CommonName: "i10 Device Test Intermediate CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	iDER, err := x509.CreateCertificate(rand.Reader, it, rc, &ik.PublicKey, rk)
	if err != nil {
		t.Fatal(err)
	}
	ic, err := x509.ParseCertificate(iDER)
	if err != nil {
		t.Fatal(err)
	}
	return &testDeviceCA{
		rootKey:  rk,
		rootCert: rc,
		rootPEM:  pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rDER}),
		intKey:   ik,
		intCert:  ic,
		intDER:   iDER,
	}
}

func (ca *testDeviceCA) issueLeaf(t *testing.T, cn string, edit func(*x509.Certificate)) (tls.Certificate, []byte) {
	t.Helper()
	lk, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(100),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	if edit != nil {
		edit(tmpl)
	}
	lDER, err := x509.CreateCertificate(rand.Reader, tmpl, ca.intCert, &lk.PublicKey, ca.intKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(lDER)
	if err != nil {
		t.Fatal(err)
	}
	spki := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	return tls.Certificate{
		Certificate: [][]byte{lDER, ca.intDER},
		PrivateKey:  lk,
		Leaf:        leaf,
	}, spki[:]
}

func (ca *testDeviceCA) bundle(t *testing.T) *ClientCAs {
	t.Helper()
	p := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(p, ca.rootPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	c := &ClientCAs{File: p}
	if err := c.Load(); err != nil {
		t.Fatal(err)
	}
	return c
}

func startFrontWithCA(t *testing.T, proto Protocol, accounts *fakeAccounts, cas *ClientCAs, tune func(*Server)) *harness {
	t.Helper()
	certs, _ := testCerts(t)
	return startFront(t, proto, accounts, func(s *Server) {
		s.ClientCAs = cas
		s.IMAPTLS = IMAPTLSConfig(certs, cas)
		if tune != nil {
			tune(s)
		}
	})
}

func aliceMac(c devicecode.Code, key []byte) projection.Device {
	return projection.Device{
		ID:          c.ID(),
		ClerkUserID: "user_alice",
		Email:       "alice@i10.test",
		Platform:    gate.Macos,
		CertKey:     bytes.Clone(key),
	}
}

func TestClientCAsReloadAndOptionalAbsence(t *testing.T) {
	ca1 := newTestDeviceCA(t)
	ca2 := newTestDeviceCA(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "bundle.pem")

	// Absent file: optional, Load succeeds with nil pool.
	cas := &ClientCAs{File: path}
	if err := cas.Load(); err != nil || cas.Pool() != nil {
		t.Fatalf("absent: err=%v pool=%v", err, cas.Pool())
	}

	// Valid bundle appears.
	if err := os.WriteFile(path, ca1.rootPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cas.Load(); err != nil || cas.Pool() == nil {
		t.Fatalf("loaded: err=%v pool=%v", err, cas.Pool())
	}
	first := cas.Pool()

	// Corrupt file fails Load and keeps previous pool.
	if err := os.WriteFile(path, []byte("not pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cas.Load(); err == nil || cas.Pool() != first {
		t.Fatalf("corrupt: err=%v pool changed=%v", err, cas.Pool() != first)
	}

	// New bundle swaps atomically.
	if err := os.WriteFile(path, ca2.rootPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := cas.Load(); err != nil || cas.Pool() == nil || cas.Pool() == first {
		t.Fatalf("reloaded: err=%v same=%v", err, cas.Pool() == first)
	}

	// Removing file clears pool back to inert.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := cas.Load(); err != nil || cas.Pool() != nil {
		t.Fatalf("removed: err=%v pool=%v", err, cas.Pool())
	}
}

// ⚠ POST-HANDSHAKE VERIFICATION RULES: chain to bundle, explicit clientAuth EKU,
// no DNS SAN, no IP SAN, CN <= 64 bytes. Any failure is treated as no certificate.
func TestVerifyClientCertRules(t *testing.T) {
	ca := newTestDeviceCA(t)
	otherCA := newTestDeviceCA(t)
	roots := ca.bundle(t).Pool()

	makeState := func(tc tls.Certificate) tls.ConnectionState {
		var peers []*x509.Certificate
		for _, der := range tc.Certificate {
			c, err := x509.ParseCertificate(der)
			if err != nil {
				t.Fatal(err)
			}
			peers = append(peers, c)
		}
		return tls.ConnectionState{PeerCertificates: peers}
	}

	good, wantKey := ca.issueLeaf(t, "C02GOODSERIAL", nil)
	got, err := verifyClientCert(makeState(good), roots, time.Now())
	if err != nil || got == nil || !bytes.Equal(got.key, wantKey) || got.cn != "C02GOODSERIAL" {
		t.Fatalf("good cert = (%+v, %v)", got, err)
	}

	// No peer cert -> (nil, nil).
	if got, err := verifyClientCert(tls.ConnectionState{}, roots, time.Now()); err != nil || got != nil {
		t.Fatalf("no cert = (%+v, %v)", got, err)
	}

	cases := map[string]tls.Certificate{
		"untrusted CA": func() tls.Certificate {
			c, _ := otherCA.issueLeaf(t, "C02OTHER", nil)
			return c
		}(),
		"expired leaf": func() tls.Certificate {
			c, _ := ca.issueLeaf(t, "C02EXP", func(tmpl *x509.Certificate) {
				tmpl.NotBefore = time.Now().Add(-48 * time.Hour)
				tmpl.NotAfter = time.Now().Add(-time.Hour)
			})
			return c
		}(),
		"empty EKU (would pass x509.Verify without explicit check)": func() tls.Certificate {
			c, _ := ca.issueLeaf(t, "C02NOEKU", func(tmpl *x509.Certificate) { tmpl.ExtKeyUsage = nil })
			return c
		}(),
		"emailProtection EKU only (SCEP cert)": func() tls.Certificate {
			c, _ := ca.issueLeaf(t, "C02SCEP", func(tmpl *x509.Certificate) {
				tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection}
			})
			return c
		}(),
		"DNS SAN present": func() tls.Certificate {
			c, _ := ca.issueLeaf(t, "C02DNS", func(tmpl *x509.Certificate) { tmpl.DNSNames = []string{"ca.i10.tech"} })
			return c
		}(),
		"IP SAN present": func() tls.Certificate {
			c, _ := ca.issueLeaf(t, "C02IP", func(tmpl *x509.Certificate) { tmpl.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")} })
			return c
		}(),
		"CN longer than 64 bytes": func() tls.Certificate {
			c, _ := ca.issueLeaf(t, strings.Repeat("A", bindtoken.MaxCNLen+1), nil)
			return c
		}(),
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got, err := verifyClientCert(makeState(tc), roots, time.Now())
			if err == nil || got != nil {
				t.Fatalf("verifyClientCert accepted %s: (%+v, %v)", name, got, err)
			}
		})
	}
}

// 993 advertises AUTH=EXTERNAL only when a client certificate verified; without
// a bundle (or without a valid cert) EXTERNAL is absent and refused. 465 never
// requests a client certificate even when a bundle is configured.
func TestTLSClientCertGatingOn993And465(t *testing.T) {
	ca := newTestDeviceCA(t)
	otherCA := newTestDeviceCA(t)
	goodCert, _ := ca.issueLeaf(t, "C02MAC1", nil)
	badCert, _ := otherCA.issueLeaf(t, "C02BAD", nil)
	dnsCert, _ := ca.issueLeaf(t, "C02DNS", func(tmpl *x509.Certificate) { tmpl.DNSNames = []string{"evil.test"} })

	t.Run("993 with no bundle never requests cert or offers EXTERNAL", func(t *testing.T) {
		h := startFrontWithCA(t, IMAP, alice(), nil, nil)
		asked := false
		c := h.dialTLS(&tls.Config{
			RootCAs:    h.roots,
			ServerName: "mail.i10.test",
			GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
				asked = true
				return &goodCert, nil
			},
		})
		greet := c.until("* OK")
		if asked {
			t.Fatal("993 requested a client certificate with no CA bundle")
		}
		if strings.Contains(greet, "AUTH=EXTERNAL") {
			t.Fatalf("greeting offered EXTERNAL with no bundle: %q", greet)
		}
		c.send("a AUTHENTICATE EXTERNAL =\r\n")
		if got := c.line(); !strings.HasPrefix(got, "a BAD") {
			t.Fatalf("EXTERNAL answered %q, want BAD", got)
		}
	})

	t.Run("993 with bundle offers EXTERNAL only when cert verified", func(t *testing.T) {
		h := startFrontWithCA(t, IMAP, alice(), ca.bundle(t), nil)

		// No cert sent: no EXTERNAL.
		noCert := h.dial()
		greet := noCert.until("* OK")
		noCert.send("a CAPABILITY\r\n")
		caps := noCert.until("* CAPABILITY")
		noCert.until("a OK")
		if strings.Contains(greet, "AUTH=EXTERNAL") || strings.Contains(caps, "AUTH=EXTERNAL") {
			t.Fatalf("offered EXTERNAL without client cert: %q / %q", greet, caps)
		}

		// Untrusted cert: treated as no cert, password login still works.
		untrusted := h.dialTLS(&tls.Config{RootCAs: h.roots, ServerName: "mail.i10.test", Certificates: []tls.Certificate{badCert}})
		if g := untrusted.until("* OK"); strings.Contains(g, "AUTH=EXTERNAL") {
			t.Fatalf("offered EXTERNAL for untrusted cert: %q", g)
		}
		untrusted.send(`a LOGIN alice@i10.test "right horse"` + "\r\n")
		untrusted.until("a OK")

		// Cert with DNS SAN: treated as no cert.
		withDNS := h.dialTLS(&tls.Config{RootCAs: h.roots, ServerName: "mail.i10.test", Certificates: []tls.Certificate{dnsCert}})
		if g := withDNS.until("* OK"); strings.Contains(g, "AUTH=EXTERNAL") {
			t.Fatalf("offered EXTERNAL for cert with DNS SAN: %q", g)
		}

		// Valid cert: greeting and CAPABILITY both advertise AUTH=EXTERNAL.
		valid := h.dialTLS(&tls.Config{RootCAs: h.roots, ServerName: "mail.i10.test", Certificates: []tls.Certificate{goodCert}})
		if g := valid.until("* OK"); !strings.Contains(g, "AUTH=EXTERNAL") {
			t.Fatalf("greeting missing AUTH=EXTERNAL: %q", g)
		}
		valid.send("c CAPABILITY\r\n")
		if caps := valid.until("* CAPABILITY"); !strings.Contains(caps, "AUTH=EXTERNAL") {
			t.Fatalf("CAPABILITY missing AUTH=EXTERNAL: %q", caps)
		}
		valid.until("c OK")
	})

	t.Run("465 never requests a client certificate", func(t *testing.T) {
		h := startFrontWithCA(t, SMTP, alice(), ca.bundle(t), nil)
		asked := false
		c := h.dialTLS(&tls.Config{
			RootCAs:    h.roots,
			ServerName: "mail.i10.test",
			GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
				asked = true
				return &goodCert, nil
			},
		})
		c.until("220")
		if asked {
			t.Fatal("465 requested a client certificate")
		}
	})
}

func TestIMAPAuthenticateExternal(t *testing.T) {
	ca := newTestDeviceCA(t)
	macCert, macKey := ca.issueLeaf(t, "C02EXTSERIAL", nil)
	code := testCode(0x21)

	dialMac := func(h *harness) *client {
		c := h.dialTLS(&tls.Config{RootCAs: h.roots, ServerName: "mail.i10.test", Certificates: []tls.Certificate{macCert}})
		c.until("* OK")
		return c
	}

	t.Run("initial response = (RFC 4959 empty)", func(t *testing.T) {
		accts := alice()
		accts.addDevice(aliceMac(code, macKey))
		h := startFrontWithCA(t, IMAP, accts, ca.bundle(t), nil)
		c := dialMac(h)
		c.send("a AUTHENTICATE EXTERNAL =\r\n")
		if got := c.until("a "); !strings.HasPrefix(got, "a OK") {
			t.Fatalf("EXTERNAL = answered %q", got)
		}
		waitFor(t, "session watched", func() bool { return h.srv.Live() == 1 })
		g := grants(h)[0]
		if g.AccountID != "user_alice" || g.DeviceID != code.ID() || !bytes.Equal(g.CertKey, macKey) {
			t.Fatalf("grant = %+v", g)
		}
		if left := time.Until(g.Until); left < CertSessionMaxAge-time.Minute || left > CertSessionMaxAge+CertSessionMaxAgeJitter {
			t.Fatalf("cert session ends in %s, want [60m, 65m)", left)
		}
		cl := h.upstream.claims()
		if len(cl) != 1 || cl[0].Mode != bindtoken.ModeExternal || cl[0].Protocol != bindtoken.IMAP ||
			cl[0].DeviceID != code.ID() || !bytes.Equal(cl[0].CertKey, macKey) || cl[0].CertCN != "C02EXTSERIAL" || cl[0].Password != "" {
			t.Fatalf("upstream claims = %+v", cl)
		}
	})

	t.Run("initial response naming own address", func(t *testing.T) {
		accts := alice()
		accts.addDevice(aliceMac(code, macKey))
		h := startFrontWithCA(t, IMAP, accts, ca.bundle(t), nil)
		c := dialMac(h)
		c.send("a AUTHENTICATE EXTERNAL " + b64("ALICE@I10.TEST") + "\r\n")
		if got := c.until("a "); !strings.HasPrefix(got, "a OK") {
			t.Fatalf("EXTERNAL own addr answered %q", got)
		}
	})

	t.Run("continuation empty line and own address", func(t *testing.T) {
		for _, resp := range []string{"", b64("alice@i10.test")} {
			accts := alice()
			accts.addDevice(aliceMac(code, macKey))
			h := startFrontWithCA(t, IMAP, accts, ca.bundle(t), nil)
			c := dialMac(h)
			c.send("a AUTHENTICATE EXTERNAL\r\n")
			c.until("+")
			c.send(resp + "\r\n")
			if got := c.until("a "); !strings.HasPrefix(got, "a OK") {
				t.Fatalf("continuation %q answered %q", resp, got)
			}
		}
	})

	t.Run("continuation cancel *", func(t *testing.T) {
		accts := alice()
		accts.addDevice(aliceMac(code, macKey))
		h := startFrontWithCA(t, IMAP, accts, ca.bundle(t), nil)
		c := dialMac(h)
		c.send("a AUTHENTICATE EXTERNAL\r\n")
		c.until("+")
		c.send("*\r\n")
		if got := c.until("a "); !strings.HasPrefix(got, "a BAD") {
			t.Fatalf("cancel answered %q, want BAD", got)
		}
		if len(h.upstream.commands()) != 0 {
			t.Fatalf("cancel forwarded %v", h.upstream.commands())
		}
		// Connection still usable.
		c.send("b AUTHENTICATE EXTERNAL =\r\n")
		c.until("b OK")
	})

	t.Run("refusals forward nothing", func(t *testing.T) {
		cases := map[string]struct {
			setup func(*fakeAccounts, *Server)
			cmd   string
			want  string
		}{
			"unbound key (no row)": {
				cmd:  "a AUTHENTICATE EXTERNAL =\r\n",
				want: "a NO [AUTHENTICATIONFAILED]",
			},
			"non-macos row carrying key": {
				setup: func(f *fakeAccounts, _ *Server) {
					d := aliceMac(code, macKey)
					d.Platform = "ios"
					f.addDevice(d)
				},
				cmd:  "a AUTHENTICATE EXTERNAL =\r\n",
				want: "a NO [AUTHENTICATIONFAILED]",
			},
			"held account (payment hold)": {
				setup: func(f *fakeAccounts, _ *Server) {
					f.addDevice(aliceMac(code, macKey))
					f.update("alice@i10.test", func(a *projection.Account) { a.PaymentHold = true })
				},
				cmd:  "a AUTHENTICATE EXTERNAL =\r\n",
				want: "a NO [AUTHENTICATIONFAILED]",
			},
			"foreign authzid": {
				setup: func(f *fakeAccounts, _ *Server) { f.addDevice(aliceMac(code, macKey)) },
				cmd:   "a AUTHENTICATE EXTERNAL " + b64("bob@i10.test") + "\r\n",
				want:  "a NO [AUTHENTICATIONFAILED]",
			},
			"NUL in authzid": {
				setup: func(f *fakeAccounts, _ *Server) { f.addDevice(aliceMac(code, macKey)) },
				cmd:   "a AUTHENTICATE EXTERNAL " + b64("alice@i10.test\x00") + "\r\n",
				want:  "a NO [AUTHENTICATIONFAILED]",
			},
			"invalid base64": {
				setup: func(f *fakeAccounts, _ *Server) { f.addDevice(aliceMac(code, macKey)) },
				cmd:   "a AUTHENTICATE EXTERNAL !!!\r\n",
				want:  "a NO [AUTHENTICATIONFAILED]",
			},
			"device lookup DB error": {
				setup: func(f *fakeAccounts, _ *Server) { f.failDevice = true },
				cmd:   "a AUTHENTICATE EXTERNAL =\r\n",
				want:  "a NO [UNAVAILABLE]",
			},
			"account lookup DB error": {
				setup: func(f *fakeAccounts, _ *Server) {
					f.addDevice(aliceMac(code, macKey))
					f.failAll = true
				},
				cmd:  "a AUTHENTICATE EXTERNAL =\r\n",
				want: "a NO [UNAVAILABLE]",
			},
			"no bind token key": {
				setup: func(f *fakeAccounts, s *Server) {
					f.addDevice(aliceMac(code, macKey))
					s.BindTokenKey = nil
				},
				cmd:  "a AUTHENTICATE EXTERNAL =\r\n",
				want: "a NO [UNAVAILABLE]",
			},
		}
		for name, tc := range cases {
			t.Run(name, func(t *testing.T) {
				accts := alice()
				h := startFrontWithCA(t, IMAP, accts, ca.bundle(t), func(s *Server) {
					if tc.setup != nil {
						tc.setup(accts, s)
					}
				})
				c := dialMac(h)
				c.send(tc.cmd)
				if got := c.until("a "); !strings.HasPrefix(got, tc.want) {
					t.Fatalf("answered %q, want prefix %q", got, tc.want)
				}
				if len(h.upstream.commands()) != 0 {
					t.Fatalf("forwarded %v", h.upstream.commands())
				}
			})
		}
	})
}

// ⚠ REVISION 5: only external or a macos device_code carries the cert key and
// gets the 60-minute cap. A password sign-in or an iPhone device_code on a
// connection that presented a Mac cert ignores the cert completely.
func TestOnlyMacDeviceSessionsCarryTheCertificateKey(t *testing.T) {
	ca := newTestDeviceCA(t)
	macCert, macKey := ca.issueLeaf(t, "C02ISOLATION", nil)
	macCode := testCode(0x22)
	iosCode := testCode(0x23)

	accts := alice()
	accts.addDevice(aliceMac(macCode, macKey))
	accts.addDevice(aliceDevice(iosCode))
	h := startFrontWithCA(t, IMAP, accts, ca.bundle(t), nil)

	dialMac := func() *client {
		c := h.dialTLS(&tls.Config{RootCAs: h.roots, ServerName: "mail.i10.test", Certificates: []tls.Certificate{macCert}})
		c.until("* OK")
		return c
	}

	// 1. Password sign-in on Mac-cert connection: no key in token, no key on Grant, zero Until (Clerk).
	c1 := dialMac()
	c1.send(`a LOGIN alice@i10.test "right horse"` + "\r\n")
	c1.until("a OK")
	waitFor(t, "1 live", func() bool { return h.srv.Live() == 1 })
	cl := h.upstream.claims()
	if cl[0].Mode != bindtoken.ModePassword || cl[0].CertKey != nil || cl[0].CertCN != "" {
		t.Fatalf("password claims carried cert: %+v", cl[0])
	}
	for _, g := range grants(h) {
		if g.CertKey != nil || !g.Until.IsZero() {
			t.Fatalf("password grant carried cert/until: %+v", g)
		}
	}

	// 2. iPhone device_code on Mac-cert connection: no key in token, no key on Grant, 24h cap.
	c2 := dialMac()
	c2.send(`a LOGIN alice@i10.test "` + iosCode.String() + `"` + "\r\n")
	c2.until("a OK")
	waitFor(t, "2 live", func() bool { return h.srv.Live() == 2 })
	cl = h.upstream.claims()
	if cl[1].Mode != bindtoken.ModeDeviceCode || cl[1].CertKey != nil || cl[1].CertCN != "" {
		t.Fatalf("iPhone claims carried cert: %+v", cl[1])
	}
	foundIOS := false
	for _, g := range grants(h) {
		if g.DeviceID == iosCode.ID() {
			foundIOS = true
			if g.CertKey != nil || time.Until(g.Until) < DeviceMaxAge-time.Minute {
				t.Fatalf("iPhone grant got cert cap: %+v", g)
			}
		}
	}
	if !foundIOS {
		t.Fatal("iPhone grant missing")
	}

	// 3. Mac device_code on Mac-cert connection: carries cert key & CN, 60m cap.
	c3 := dialMac()
	c3.send(`a LOGIN alice@i10.test "` + macCode.String() + `"` + "\r\n")
	c3.until("a OK")
	waitFor(t, "3 live", func() bool { return h.srv.Live() == 3 })
	cl = h.upstream.claims()
	if cl[2].Mode != bindtoken.ModeDeviceCode || !bytes.Equal(cl[2].CertKey, macKey) || cl[2].CertCN != "C02ISOLATION" {
		t.Fatalf("Mac code claims missing cert: %+v", cl[2])
	}
	foundMac := false
	for _, g := range grants(h) {
		if g.DeviceID == macCode.ID() {
			foundMac = true
			if !bytes.Equal(g.CertKey, macKey) || time.Until(g.Until) > CertSessionMaxAge+CertSessionMaxAgeJitter {
				t.Fatalf("Mac code grant = %+v", g)
			}
		}
	}
	if !foundMac {
		t.Fatal("Mac grant missing")
	}
}

// ⚠ FRONT-OWNED SMTP AUTH: the front answers every 334 itself, handles cancel
// and lookup failures without reaching Stalwart, rewrites LOGIN to ONE AUTH PLAIN,
// and applies the Mac SMTP liveness 454 rule strictly.
func TestSMTPFrontOwnedAuthExchange(t *testing.T) {
	t.Run("LOGIN rewritten to one AUTH PLAIN with no 334 from Stalwart", func(t *testing.T) {
		h := startFront(t, SMTP, alice(), nil)
		c := h.dial()
		c.until("220")
		c.send("EHLO mac.local\r\n")
		c.until("250 ")
		c.send("AUTH LOGIN\r\n")
		if got := c.line(); got != "334 VXNlcm5hbWU6" {
			t.Fatalf("username prompt = %q", got)
		}
		c.send(b64("alice@i10.test") + "\r\n")
		if got := c.line(); got != "334 UGFzc3dvcmQ6" {
			t.Fatalf("password prompt = %q", got)
		}
		c.send(b64(rightPassword) + "\r\n")
		if got := c.line(); !strings.HasPrefix(got, "235") {
			t.Fatalf("AUTH answered %q", got)
		}
		cmds := h.upstream.commands()
		authCmds := 0
		for _, cmd := range cmds {
			if strings.HasPrefix(cmd, "AUTH LOGIN") {
				t.Fatalf("forwarded AUTH LOGIN to Stalwart: %v", cmds)
			}
			if strings.HasPrefix(cmd, "AUTH PLAIN ") {
				authCmds++
			}
		}
		if authCmds != 1 {
			t.Fatalf("expected 1 AUTH PLAIN command upstream, got %v", cmds)
		}
	})

	t.Run("cancel * on PLAIN and LOGIN answers 501 and forwards nothing", func(t *testing.T) {
		cases := []struct {
			name  string
			steps []string
		}{
			{"PLAIN continuation cancel", []string{"AUTH PLAIN", "*"}},
			{"LOGIN username cancel", []string{"AUTH LOGIN", "*"}},
			{"LOGIN password cancel", []string{"AUTH LOGIN", b64("alice@i10.test"), "*"}},
			{"LOGIN inline user, password cancel", []string{"AUTH LOGIN " + b64("alice@i10.test"), "*"}},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				h := startFront(t, SMTP, alice(), nil)
				c := h.dial()
				c.until("220")
				for i, s := range tc.steps {
					if i > 0 {
						c.until("334")
					}
					c.send(s + "\r\n")
				}
				if got := c.line(); !strings.HasPrefix(got, "501 ") {
					t.Fatalf("cancel answered %q, want 501", got)
				}
				if len(h.upstream.commands()) != 0 {
					t.Fatalf("forwarded %v on cancel", h.upstream.commands())
				}
				// Connection stays usable for a real sign-in after cancel.
				c.send("AUTH PLAIN " + plain("", "alice@i10.test", rightPassword) + "\r\n")
				if got := c.line(); !strings.HasPrefix(got, "235") {
					t.Fatalf("sign-in after cancel answered %q", got)
				}
			})
		}
	})

	t.Run("lookup failure answers 454 on PLAIN and LOGIN and forwards nothing", func(t *testing.T) {
		cases := []struct {
			name  string
			steps []string
		}{
			{"PLAIN inline", []string{"AUTH PLAIN " + plain("", "alice@i10.test", rightPassword)}},
			{"PLAIN continuation", []string{"AUTH PLAIN", plain("", "alice@i10.test", rightPassword)}},
			{"LOGIN", []string{"AUTH LOGIN", b64("alice@i10.test"), b64(rightPassword)}},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				accts := alice()
				accts.failAll = true
				h := startFront(t, SMTP, accts, nil)
				c := h.dial()
				c.until("220")
				for i, s := range tc.steps {
					if i > 0 {
						c.until("334")
					}
					c.send(s + "\r\n")
				}
				if got := c.line(); !strings.HasPrefix(got, "454 4.7.0") {
					t.Fatalf("lookup failure answered %q, want 454 4.7.0", got)
				}
				if len(h.upstream.commands()) != 0 {
					t.Fatalf("forwarded %v on lookup failure", h.upstream.commands())
				}
			})
		}
	})
}

func TestSMTPMacLivenessPreCheckAndSessionCap(t *testing.T) {
	code := testCode(0x24)
	macKey := bytes.Repeat([]byte{0x55}, 32)
	otherKey := bytes.Repeat([]byte{0x66}, 32)
	loopbackPrefix := projection.MacLivePrefix(netip.MustParseAddr("127.0.0.1"))
	otherPrefix := projection.MacLivePrefix(netip.MustParseAddr("198.51.100.9"))

	t.Run("live Mac signs in on SMTP, Grant carries key and 60m cap, key clear/change closes it", func(t *testing.T) {
		for _, change := range []struct {
			name   string
			mutate func(*fakeAccounts)
			reason string
		}{
			{"key cleared", func(f *fakeAccounts) {
				d := aliceMac(code, nil)
				f.addDevice(d)
			}, gate.DeviceCertMissing},
			{"key changed", func(f *fakeAccounts) {
				d := aliceMac(code, otherKey)
				f.addDevice(d)
			}, gate.DeviceKeyChanged},
		} {
			t.Run(change.name, func(t *testing.T) {
				logs := &lockedBuffer{}
				accts := alice()
				accts.addDevice(aliceMac(code, macKey))
				accts.setMacLive(code.ID(), loopbackPrefix, macKey)
				h := startFront(t, SMTP, accts, func(s *Server) {
					s.Log = slog.New(slog.NewTextHandler(logs, nil))
				})
				c := h.dial()
				c.until("220")
				c.send("AUTH LOGIN\r\n")
				c.until("334")
				c.send(b64("alice@i10.test") + "\r\n")
				c.until("334")
				c.send(b64(code.String()) + "\r\n")
				if got := c.line(); !strings.HasPrefix(got, "235") {
					t.Fatalf("live Mac SMTP answered %q", got)
				}
				waitFor(t, "watched", func() bool { return h.srv.Live() == 1 })
				g := grants(h)[0]
				if g.DeviceID != code.ID() || !bytes.Equal(g.CertKey, macKey) {
					t.Fatalf("SMTP Mac grant = %+v", g)
				}
				if left := time.Until(g.Until); left < CertSessionMaxAge-time.Minute || left > CertSessionMaxAge+CertSessionMaxAgeJitter {
					t.Fatalf("SMTP Mac grant until = %s", left)
				}
				cl := h.upstream.claims()
				if len(cl) != 1 || cl[0].Protocol != bindtoken.SMTP || cl[0].CertKey != nil || cl[0].Mode != bindtoken.ModeDeviceCode {
					t.Fatalf("SMTP Mac claims = %+v", cl)
				}
				if st := h.sweeper.Poll(context.Background()); st.Closed != 0 {
					t.Fatalf("initial poll closed %d", st.Closed)
				}
				change.mutate(accts)
				if st := h.sweeper.Poll(context.Background()); st.Closed != 1 {
					t.Fatalf("poll after %s closed %d, want 1", change.name, st.Closed)
				}
				if !c.closed(time.Second) {
					t.Fatal("SMTP session still open after key change/clear")
				}
				waitFor(t, "reason "+change.reason, func() bool { return strings.Contains(logs.String(), "reason="+change.reason) })
			})
		}
	})

	t.Run("missing liveness row answers 454 up to 3 times then closes, forwarding nothing", func(t *testing.T) {
		accts := alice()
		accts.addDevice(aliceMac(code, macKey))
		h := startFront(t, SMTP, accts, nil)
		c := h.dial()
		c.until("220")
		for i := 1; i <= 3; i++ {
			c.send("AUTH PLAIN " + plain("", "alice@i10.test", code.String()) + "\r\n")
			if got := c.line(); !strings.HasPrefix(got, "454 4.7.0") {
				t.Fatalf("attempt %d answered %q, want 454 4.7.0", i, got)
			}
		}
		if !c.closed(time.Second) {
			t.Fatal("connection stayed open after 3 Mac liveness 454s")
		}
		if len(h.upstream.commands()) != 0 {
			t.Fatalf("forwarded %v when liveness missing", h.upstream.commands())
		}
	})

	t.Run("same-address switch off allows liveness from another address", func(t *testing.T) {
		accts := alice()
		accts.addDevice(aliceMac(code, macKey))
		accts.setMacLive(code.ID(), otherPrefix, macKey)

		// Default (strict): 454.
		hStrict := startFront(t, SMTP, accts, nil)
		c1 := hStrict.dial()
		c1.until("220")
		c1.send("AUTH PLAIN " + plain("", "alice@i10.test", code.String()) + "\r\n")
		if got := c1.line(); !strings.HasPrefix(got, "454 4.7.0") {
			t.Fatalf("strict answered %q, want 454", got)
		}

		// Any-address switch on: forwarded and signs in.
		hAny := startFront(t, SMTP, accts, func(s *Server) { s.MacSMTPAnyAddress = true })
		c2 := hAny.dial()
		c2.until("220")
		c2.send("AUTH PLAIN " + plain("", "alice@i10.test", code.String()) + "\r\n")
		if got := c2.line(); !strings.HasPrefix(got, "235") {
			t.Fatalf("any-address answered %q, want 235", got)
		}
	})

	// ⚠ REVISION 5: the front's 454 NEVER reveals more than authd would. If the
	// account is held, the device is unknown, its key is missing, or it mismatches
	// the account, the front forwards to Stalwart/authd instead of answering 454.
	t.Run("454 only when account, gate, device and DeviceRefusal all pass", func(t *testing.T) {
		cases := map[string]func(*fakeAccounts){
			"unknown device id": func(*fakeAccounts) {},
			"device has no key (device_cert_missing)": func(f *fakeAccounts) {
				f.addDevice(aliceMac(code, nil))
			},
			"device belongs to another person": func(f *fakeAccounts) {
				d := aliceMac(code, macKey)
				d.ClerkUserID = "user_bob"
				f.addDevice(d)
			},
			"account is held (payment hold)": func(f *fakeAccounts) {
				f.addDevice(aliceMac(code, macKey))
				f.update("alice@i10.test", func(a *projection.Account) { a.PaymentHold = true })
			},
			"iPhone device code (no liveness check)": func(f *fakeAccounts) {
				f.addDevice(aliceDevice(code))
			},
		}
		for name, setup := range cases {
			t.Run(name, func(t *testing.T) {
				accts := alice()
				setup(accts)
				h := startFront(t, SMTP, accts, nil)
				h.upstream.refuseDevices = true
				c := h.dial()
				c.until("220")
				c.send("AUTH PLAIN " + plain("", "alice@i10.test", code.String()) + "\r\n")
				got := c.line()
				if strings.HasPrefix(got, "454") {
					t.Fatalf("%s: front answered 454 (%q), must forward to authd instead", name, got)
				}
				if len(h.upstream.commands()) != 1 {
					t.Fatalf("%s: expected 1 forwarded AUTH PLAIN, got %v", name, h.upstream.commands())
				}
			})
		}
	})

	t.Run("MacLive DB error answers 454 and forwards nothing", func(t *testing.T) {
		accts := alice()
		accts.addDevice(aliceMac(code, macKey))
		accts.failLive = true
		h := startFront(t, SMTP, accts, nil)
		c := h.dial()
		c.until("220")
		c.send("AUTH PLAIN " + plain("", "alice@i10.test", code.String()) + "\r\n")
		if got := c.line(); !strings.HasPrefix(got, "454 4.7.0") {
			t.Fatalf("live error answered %q, want 454", got)
		}
		if len(h.upstream.commands()) != 0 {
			t.Fatalf("forwarded %v on MacLive error", h.upstream.commands())
		}
	})
}

func TestCertSessionsEndAtCertSessionMaxAge(t *testing.T) {
	acct := account("user_alice", "alice@i10.test")
	key := bytes.Repeat([]byte{0x77}, 32)
	soon := time.Now().Add(40 * time.Millisecond)
	g, reason := admit(&acct, "d-mac", key, nil, sessionEnds{
		passthrough: time.Now().Add(time.Hour),
		device:      time.Now().Add(24 * time.Hour),
		cert:        soon,
	})
	if reason != "" || g.Until != soon || !bytes.Equal(g.CertKey, key) {
		t.Fatalf("admit = %+v, %q", g, reason)
	}
	r := newPollRig(t, acct)
	r.accounts.failAll = true
	r.register(g)
	time.Sleep(50 * time.Millisecond)
	if st := r.poll(); st.Closed != 1 || r.closed["user_alice"] != ReasonCertMaxAge {
		t.Fatalf("poll %+v closed %v, want %s", st, r.closed, ReasonCertMaxAge)
	}

	at := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	lo, hi := 2*time.Hour, time.Duration(0)
	for range 2000 {
		d := certUntil(at).Sub(at)
		if d < CertSessionMaxAge || d >= CertSessionMaxAge+CertSessionMaxAgeJitter {
			t.Fatalf("certUntil %s out of [%s, %s)", d, CertSessionMaxAge, CertSessionMaxAge+CertSessionMaxAgeJitter)
		}
		lo, hi = min(lo, d), max(hi, d)
	}
	if hi-lo < CertSessionMaxAgeJitter/2 {
		t.Fatalf("2000 cert sessions ended within %s: not spread", hi-lo)
	}
}
