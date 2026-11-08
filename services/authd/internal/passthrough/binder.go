package passthrough

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"time"

	ldap "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/egress"
)

// Outcome is the tri-state a bind needs, as in clerkauth: "we could not find
// out" is not "wrong password", and collapsing them makes every mail client in
// the fleet prompt its user over an outage that was never theirs.
type Outcome int

const (
	// Rejected: the directory answered, and the answer was no (or the person is
	// not there).
	Rejected Outcome = iota
	// Verified: the person's own bind to the directory succeeded.
	Verified
	// Unavailable: the directory, the path to it or our settings for it did not
	// work. Never reported to the client as invalid credentials.
	Unavailable
)

// searchTimeLimit is the server-side limit on the search, in seconds.
const searchTimeLimit = 5

// Reason codes. These are what is logged: never a password, a secret or a DN.
const (
	ReasonEmptyPassword     = "empty_password"
	ReasonPassthroughOff    = "passthrough_off"
	ReasonSettingsDown      = "settings_unavailable"
	ReasonBadSettings       = "bad_settings"
	ReasonHostBlocked       = "host_blocked"
	ReasonDNSFailed         = "dns_failed"
	ReasonDialFailed        = "dial_failed"
	ReasonTLSFailed         = "tls_failed"
	ReasonServiceBindFailed = "service_bind_failed"
	ReasonSearchFailed      = "search_failed"
	ReasonUserNotFound      = "user_not_found"
	ReasonAmbiguousEntry    = "ambiguous_entry"
	ReasonEmptyDN           = "empty_dn"
	ReasonUserBindRejected  = "user_bind_rejected"
	ReasonUserBindError     = "user_bind_error"
	ReasonVerified          = "verified"
)

// Result is what a bind learned, and why, in a word.
type Result struct {
	Outcome Outcome
	Reason  string
	// Lane is the lane that answered (LaneLDAP, LaneOIDC), or "" when none did:
	// the connection is off, or its settings could not be had.
	Lane string
	// Preset is the OIDC preset that answered, for the log; "" for any other lane.
	Preset string
}

// Binder walks one bind against a company's directory.
type Binder struct {
	// Resolver is DNS for the host check; net.DefaultResolver when nil.
	Resolver egress.Resolver
	// Dial opens the connection to the VETTED address. Production dials TCP;
	// tests point it at their directory.
	Dial func(ctx context.Context, network, address string) (net.Conn, error)

	DialTimeout time.Duration
	// OpTimeout bounds each LDAP operation; TotalTimeout the whole walk.
	OpTimeout    time.Duration
	TotalTimeout time.Duration
}

func (b *Binder) resolver() egress.Resolver {
	if b.Resolver != nil {
		return b.Resolver
	}
	return net.DefaultResolver
}

func orDefault(d, fallback time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return fallback
}

// Bind verifies email's password against the directory described by s.
//
// ⚠ THE ORDER IS THE SECURITY PROPERTY: the host is vetted before a socket is
// opened; TLS is up before anything is sent (ldaps is TLS from the first byte,
// StartTLS is the first operation); the service secret goes only to a verified
// server; and the answer is the user's own bind, nothing else.
//
// ⚠ THE PASSWORD IS NEVER LOGGED, WRAPPED INTO AN ERROR OR KEPT. Neither is
// the service secret or any DN: this returns reason codes only.
func (b *Binder) Bind(ctx context.Context, s Settings, email, password string) Result {
	// An empty password is an UNAUTHENTICATED bind (RFC 4513 5.1.2): many
	// servers answer it with success. The caller refuses it too; this is the
	// last line.
	if password == "" {
		return Result{Outcome: Rejected, Reason: ReasonEmptyPassword}
	}
	if err := s.Validate(); err != nil {
		return Result{Outcome: Unavailable, Reason: ReasonBadSettings}
	}
	roots, ok := rootsFor(s.CAPem)
	if !ok {
		return Result{Outcome: Unavailable, Reason: ReasonBadSettings}
	}

	ctx, cancel := context.WithTimeout(ctx, orDefault(b.TotalTimeout, 15*time.Second))
	defer cancel()

	addr, err := egress.Vet(ctx, b.resolver(), s.Host)
	switch {
	case errors.Is(err, egress.ErrBlocked):
		return Result{Outcome: Unavailable, Reason: ReasonHostBlocked}
	case err != nil:
		return Result{Outcome: Unavailable, Reason: ReasonDNSFailed}
	}

	conn, res := b.connect(ctx, s, addr, roots)
	if conn == nil {
		return res
	}
	defer conn.Close()
	conn.SetTimeout(orDefault(b.OpTimeout, 5*time.Second))

	// The service account first. Whatever it answers is about OUR settings,
	// not about the person, so none of it is a rejection.
	if err := conn.Bind(s.BindDN, s.BindSecret); err != nil {
		return Result{Outcome: Unavailable, Reason: ReasonServiceBindFailed}
	}

	res2, dn := search(conn, s, email)
	if dn == "" {
		return res2
	}

	// ⚠ THE ONLY SUCCESS: the person's own bind, with the password they gave.
	if err := conn.Bind(dn, password); err != nil {
		if ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
			return Result{Outcome: Rejected, Reason: ReasonUserBindRejected}
		}
		return Result{Outcome: Unavailable, Reason: ReasonUserBindError}
	}
	return Result{Outcome: Verified, Reason: ReasonVerified}
}

// rootsFor is the pinned CA as a pool, or nil for the system roots. The bool is
// false when a pinned CA was given and holds no usable certificate: that must
// stop the bind, not quietly fall back to the system roots.
func rootsFor(caPem string) (*x509.CertPool, bool) {
	if caPem == "" {
		return nil, true
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(caPem)) {
		return nil, false
	}
	return pool, true
}

// connect opens the connection to addr with TLS established, or says why not.
func (b *Binder) connect(ctx context.Context, s Settings, addr netip.Addr, roots *x509.CertPool) (*ldap.Conn, Result) {
	dial := b.Dial
	if dial == nil {
		d := &net.Dialer{Timeout: orDefault(b.DialTimeout, 5*time.Second)}
		dial = d.DialContext
	}
	dialCtx, cancel := context.WithTimeout(ctx, orDefault(b.DialTimeout, 5*time.Second))
	defer cancel()
	raw, err := dial(dialCtx, "tcp", net.JoinHostPort(addr.String(), strconv.Itoa(s.Port)))
	if err != nil {
		return nil, Result{Outcome: Unavailable, Reason: ReasonDialFailed}
	}
	// The whole walk's deadline, on the socket itself: a server that stops
	// answering mid-handshake cannot hold a goroutine past it.
	if dl, ok := ctx.Deadline(); ok {
		_ = raw.SetDeadline(dl)
	}

	// ⚠ THE NAME THE CERTIFICATE IS CHECKED AGAINST is the configured host,
	// while the socket is to the vetted address.
	cfg := &tls.Config{ServerName: s.Host, RootCAs: roots, MinVersion: tls.VersionTLS12}

	if s.TLSMode == TLSModeLDAPS {
		t := tls.Client(raw, cfg)
		if err := t.HandshakeContext(ctx); err != nil {
			_ = raw.Close()
			return nil, Result{Outcome: Unavailable, Reason: ReasonTLSFailed}
		}
		conn := ldap.NewConn(t, true)
		conn.Start()
		return conn, Result{}
	}

	conn := ldap.NewConn(raw, false)
	conn.Start()
	conn.SetTimeout(orDefault(b.OpTimeout, 5*time.Second))
	// ⚠ THE FIRST OPERATION. A server that will not upgrade is a refusal; no
	// bind is ever sent in the clear.
	if err := conn.StartTLS(cfg); err != nil {
		conn.Close()
		return nil, Result{Outcome: Unavailable, Reason: ReasonTLSFailed}
	}
	return conn, Result{}
}

// search finds the one entry for email. A DN comes back only for exactly one.
func search(conn *ldap.Conn, s Settings, email string) (Result, string) {
	req := ldap.NewSearchRequest(
		s.SearchBase,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		2, // one more than wanted, so "several" can be told from "one"
		searchTimeLimit,
		false,
		RenderFilter(s.UserFilter, email),
		[]string{"1.1"}, // the DN and nothing else
		nil,
	)
	res, err := conn.Search(req)
	if err != nil && !ldap.IsErrorWithCode(err, ldap.LDAPResultSizeLimitExceeded) {
		return Result{Outcome: Unavailable, Reason: ReasonSearchFailed}, ""
	}
	switch {
	case res == nil || len(res.Entries) == 0:
		return Result{Outcome: Rejected, Reason: ReasonUserNotFound}, ""
	case len(res.Entries) > 1 || err != nil:
		return Result{Outcome: Rejected, Reason: ReasonAmbiguousEntry}, ""
	case res.Entries[0].DN == "":
		return Result{Outcome: Rejected, Reason: ReasonEmptyDN}, ""
	}
	return Result{}, res.Entries[0].DN
}
