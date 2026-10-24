// Package ldaptest is a small LDAP directory for tests: a company's server as
// pass-through sees it, over ldaps, over StartTLS, or in plaintext.
//
// It exists in its own package, rather than in a _test file, because both the
// pass-through tests and authd's end-to-end bind tests need it. Nothing in
// authd imports it outside tests.
package ldaptest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"sync"
	"testing"
	"time"

	ber "github.com/go-asn1-ber/asn1-ber"
	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/directory"
)

// Mode is how the server speaks.
type Mode int

const (
	// LDAPS is TLS from the first byte.
	LDAPS Mode = iota
	// StartTLS is plaintext until the client upgrades.
	StartTLS
	// Plain never offers TLS at all.
	Plain
)

// Host is the name the server's certificate is issued for.
const Host = "ldap.acme.test"

const (
	ServiceDN     = "cn=i10,ou=services,dc=acme,dc=test"
	ServiceSecret = "service-secret"
)

// Person is one entry in the directory.
type Person struct {
	DN       string
	Mail     string
	Password string
}

// Server is a running test directory.
type Server struct {
	// Addr is where it listens (a loopback address and a random port).
	Addr string
	// CAPem is the certificate it presents, which is also its own CA.
	CAPem string

	mode   Mode
	people []Person

	mu           sync.Mutex
	binds        []string
	plaintextOps int
}

// Start runs a directory until the test ends.
func Start(t testing.TB, mode Mode, people ...Person) *Server {
	t.Helper()
	cert, caPem := newCert(t)
	s := &Server{mode: mode, people: people, CAPem: caPem}
	cfg := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s.Addr = ln.Addr().String()
	switch mode {
	case LDAPS:
		ln = tls.NewListener(ln, cfg)
	case StartTLS:
		ln = &upgradeListener{Listener: ln, cfg: cfg, srv: s}
	}

	srv := ldap.NewServer()
	srv.Handle(s.routes())
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
	})
	return s
}

// Binds lists the DN of every bind the directory received, in order.
func (s *Server) Binds() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.binds...)
}

// PlaintextOps counts operations that arrived before TLS (StartTLS mode only).
func (s *Server) PlaintextOps() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.plaintextOps
}

func (s *Server) routes() *ldap.RouteMux {
	m := ldap.NewRouteMux()
	m.NotFound(func(w ldap.ResponseWriter, _ *ldap.Message) {
		w.Write(ldap.NewResponse(ldap.LDAPResultUnwillingToPerform))
	})
	m.Bind(s.handleBind)
	m.Search(s.handleSearch)
	return m
}

func (s *Server) handleBind(w ldap.ResponseWriter, m *ldap.Message) {
	r := m.GetBindRequest()
	name, pass := string(r.Name()), string(r.AuthenticationSimple())
	s.mu.Lock()
	s.binds = append(s.binds, name)
	s.mu.Unlock()

	ok := name == ServiceDN && pass == ServiceSecret
	for _, p := range s.people {
		// An empty password is never a match: that would be an unauthenticated
		// bind answered with success.
		if p.DN == name && pass != "" && p.Password == pass {
			ok = true
		}
	}
	if ok {
		w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))
		return
	}
	w.Write(ldap.NewBindResponse(ldap.LDAPResultInvalidCredentials))
}

func (s *Server) handleSearch(w ldap.ResponseWriter, m *ldap.Message) {
	r := m.GetSearchRequest()
	limit := int(r.SizeLimit())
	sent := 0
	for _, p := range s.people {
		e := directory.NewEntry(p.DN).Set(directory.AttrMail, p.Mail)
		if !directory.Match(r.Filter(), e) {
			continue
		}
		if limit > 0 && sent >= limit {
			w.Write(ldap.NewSearchResultDoneResponse(ldap.LDAPResultSizeLimitExceeded))
			return
		}
		w.Write(ldap.NewSearchResultEntry(p.DN))
		sent++
	}
	w.Write(ldap.NewSearchResultDoneResponse(ldap.LDAPResultSuccess))
}

func newCert(t testing.TB) (tls.Certificate, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("key: %v", err)
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: Host},
		DNSNames:              []string{Host},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("cert: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
		string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// ── StartTLS ───────────────────────────────────────────────────────────────
//
// ldapserver hides its connection, so the upgrade is done underneath it: the
// first message of every connection is read here. A StartTLS request is
// answered and the connection becomes TLS; anything else is counted as an
// operation sent in the clear and handed on untouched.

const startTLSOID = "1.3.6.1.4.1.1466.20037"

type upgradeListener struct {
	net.Listener
	cfg *tls.Config
	srv *Server
}

func (l *upgradeListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &upgradeConn{Conn: c, cfg: l.cfg, srv: l.srv}, nil
}

type upgradeConn struct {
	net.Conn
	cfg       *tls.Config
	srv       *Server
	inspected bool
	pending   []byte
}

func (c *upgradeConn) Read(b []byte) (int, error) {
	if !c.inspected {
		c.inspected = true
		p, err := ber.ReadPacket(c.Conn)
		if err != nil {
			return 0, err
		}
		if id, ok := startTLSRequest(p); ok {
			if _, err := c.Conn.Write(startTLSResponse(id).Bytes()); err != nil {
				return 0, err
			}
			c.Conn = tls.Server(c.Conn, c.cfg)
		} else {
			c.srv.mu.Lock()
			c.srv.plaintextOps++
			c.srv.mu.Unlock()
			c.pending = p.Bytes()
		}
	}
	if len(c.pending) > 0 {
		n := copy(b, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	return c.Conn.Read(b)
}

func startTLSRequest(p *ber.Packet) (int64, bool) {
	if len(p.Children) < 2 {
		return 0, false
	}
	id, ok := p.Children[0].Value.(int64)
	op := p.Children[1]
	if !ok || op.ClassType != ber.ClassApplication || op.Tag != 23 || len(op.Children) == 0 {
		return 0, false
	}
	// [0] requestName is context-specific, so the library leaves it as bytes.
	oid := op.Children[0]
	return id, oid.Data != nil && string(oid.Data.Bytes()) == startTLSOID
}

func startTLSResponse(id int64) *ber.Packet {
	msg := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "LDAPMessage")
	msg.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "messageID"))
	resp := ber.Encode(ber.ClassApplication, ber.TypeConstructed, 24, nil, "ExtendedResponse")
	resp.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, int64(0), "resultCode"))
	resp.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "matchedDN"))
	resp.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "diagnosticMessage"))
	msg.AppendChild(resp)
	return msg
}
