// Package mailfront is the TLS front for IMAP (993) and SMTP submission (465).
//
// It terminates TLS, hands each connection to Stalwart over PROXY v2 with the
// SSL extension, learns which account the connection signs in as, and closes it
// the moment that account loses access. Stalwart cannot do the last part: v1.1.0
// never ended a session that had already signed in (docs/research/mail-device-
// binding.md section 6), and v1.2.0 ends an IMAP one only when the account's
// permissions or password change inside Stalwart, on its next command. An
// authd revocation is not such a change, and SMTP has no such check (probed
// 2026-11-23, infra/k8s/i10/stalwart/config/README.md, "Upgrading to 1.2.0").
//
// It is its own process, not part of authd. See "Mail front" in
// services/authd/README.md for why, the port layout and the failure modes.
package mailfront

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Protocol is what a listener speaks.
type Protocol int

const (
	IMAP Protocol = iota
	SMTP
)

func (p Protocol) String() string {
	if p == SMTP {
		return "smtp"
	}
	return "imap"
}

// Server accepts clients on any number of listeners and runs one sweeper (its
// poll and its backstop sweep) over all of them.
type Server struct {
	Accounts Accounts
	// TLS is the server TLS config for 465 (and for 993 when IMAPTLS is nil).
	// It never asks for a client certificate.
	TLS *tls.Config
	// IMAPTLS is the separate TLS config for 993 (IMAPTLSConfig), requesting a
	// client certificate when ClientCAs holds a trust pool. Nil falls back to TLS.
	IMAPTLS *tls.Config
	// ClientCAs holds the device CA trust pool used to verify client certificates
	// after the 993 handshake. Nil (or empty pool) disables client certs and EXTERNAL.
	ClientCAs *ClientCAs
	Log       *slog.Logger
	Limits    Limits

	// MaxConns caps every connection on this front; MaxPreAuth caps the ones
	// that have not signed in, and MaxPreAuthPerIP the ones from one address.
	MaxConns, MaxPreAuth, MaxPreAuthPerIP int

	// DialTimeout bounds the connection to Stalwart, which is on loopback.
	DialTimeout time.Duration

	// BindTokenKey signs the token every forwarded sign-in carries
	// (internal/bindtoken), which authd requires on every person bind. Nil: the
	// front forwards no sign-in, and answers each one as temporarily unavailable.
	BindTokenKey *bindtoken.Key

	// PassthroughMaxAge is how long a session signed in through a pass-through
	// lane stays open (DefaultPassthroughMaxAge). Each session ends up to a tenth
	// sooner, at random, so clients that signed in together do not all come back
	// together; none outlives it.
	PassthroughMaxAge time.Duration

	// MacSMTPAnyAddress drops the address part of the Mac SMTP liveness check
	// (MAILFRONT_MAC_SMTP_SAME_ADDRESS=false), in lockstep with authd's
	// AUTHD_MAC_SMTP_SAME_ADDRESS.
	MacSMTPAnyAddress bool

	reg *registry

	mu       sync.Mutex
	sessions map[*session]struct{}
	perIP    map[string]int
	preAuth  int
	total    int
	closing  bool
	wg       sync.WaitGroup
	nextID   atomic.Uint64

	// refused counts connections turned away at accept in the current report
	// window, by the cap that turned them away; see admitConn.
	refused map[string]int
	// refusedWindow is how long refusals at accept are counted before they are
	// reported in one line. A reconnect surge can refuse thousands of
	// connections in a second; one line each would be the flood, and none would
	// hide it.
	refusedWindow time.Duration
}

// NewServer returns a server with its registry; s.Sweeper uses the same one.
func NewServer(accounts Accounts, tlsConf *tls.Config, log *slog.Logger) *Server {
	return &Server{
		Accounts:          accounts,
		TLS:               tlsConf,
		Log:               log,
		Limits:            DefaultLimits,
		MaxConns:          6000,
		MaxPreAuth:        2000,
		MaxPreAuthPerIP:   32,
		DialTimeout:       2 * time.Second,
		PassthroughMaxAge: DefaultPassthroughMaxAge,
		reg:               newRegistry(),
		sessions:          map[*session]struct{}{},
		perIP:             map[string]int{},
		refused:           map[string]int{},
		refusedWindow:     10 * time.Second,
	}
}

// Sweeper returns the sweeper over this server's connections.
func (s *Server) Sweeper(interval, timeout time.Duration) *Sweeper {
	return &Sweeper{Accounts: s.Accounts, Interval: interval, Backstop: DefaultBackstop, Timeout: timeout,
		MaxChanges: DefaultMaxChanges, Log: s.Log, reg: s.reg, fullSweep: make(chan struct{}, 1)}
}

// Live is the number of signed-in connections.
func (s *Server) Live() int { return s.reg.len() }

// Serve accepts on ln until it is closed, handing each client to upstream.
func (s *Server) Serve(ln net.Listener, proto Protocol, upstream string) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return err
		}
		ip := remoteIP(c)
		if !s.admitConn(ip) {
			_ = c.Close()
			continue
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handle(c, ip, proto, upstream)
		}()
	}
}

// admitConn applies the connection caps at accept, before any TLS work. A
// refusal is counted by the cap that made it. The first one opens a report
// window; when it ends, everything refused in it is logged in one line.
func (s *Server) admitConn(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	var cap string
	switch {
	case s.closing:
		return false
	case s.total >= s.MaxConns:
		cap = "max_connections"
	case s.preAuth >= s.MaxPreAuth:
		cap = "max_preauth"
	case s.perIP[ip] >= s.MaxPreAuthPerIP:
		cap = "max_preauth_per_ip"
	default:
		s.total++
		s.preAuth++
		s.perIP[ip]++
		return true
	}
	if len(s.refused) == 0 {
		time.AfterFunc(s.refusedWindow, s.reportRefused)
	}
	s.refused[cap]++
	return false
}

// reportRefused logs the refusals of the window that just ended.
func (s *Server) reportRefused() {
	s.mu.Lock()
	refused := s.refused
	s.refused = map[string]int{}
	s.mu.Unlock()
	s.Log.Warn("refused connections at accept: a cap was full, clients will retry",
		"refused", refused, "over", s.refusedWindow.String())
}

func (s *Server) leavePreAuth(ip string) {
	s.mu.Lock()
	s.preAuth--
	if s.perIP[ip]--; s.perIP[ip] <= 0 {
		delete(s.perIP, ip)
	}
	s.mu.Unlock()
}

func (s *Server) handle(raw net.Conn, ip string, proto Protocol, upstream string) {
	start := time.Now()
	id := s.nextID.Add(1)
	log := s.Log.With("conn", id, "proto", proto.String(), "remote", raw.RemoteAddr().String())
	inPreAuth := true
	defer func() {
		if inPreAuth {
			s.leavePreAuth(ip)
		}
		s.mu.Lock()
		s.total--
		s.mu.Unlock()
	}()

	deadline := start.Add(s.Limits.PreAuth)
	_ = raw.SetDeadline(deadline)
	tlsConf := s.TLS
	if proto == IMAP && s.IMAPTLS != nil {
		tlsConf = s.IMAPTLS
	}
	client := tls.Server(raw, tlsConf)
	hctx, cancel := context.WithTimeout(context.Background(), s.Limits.Handshake)
	err := client.HandshakeContext(hctx)
	cancel()
	if err != nil {
		_ = raw.Close()
		log.Debug("tls handshake failed", slog.Any("err", err))
		return
	}

	var cert *verifiedCert
	if proto == IMAP && s.ClientCAs != nil {
		if roots := s.ClientCAs.Pool(); roots != nil {
			var cerr error
			cert, cerr = verifyClientCert(client.ConnectionState(), roots, time.Now())
			if cerr != nil {
				log.Info("client certificate rejected, treating connection as without one", slog.Any("err", cerr))
			}
		}
	}

	up, err := net.DialTimeout("tcp", upstream, s.DialTimeout)
	if err != nil {
		_ = client.Close()
		log.Error("cannot reach stalwart", "upstream", upstream, slog.Any("err", err))
		return
	}
	_ = up.SetDeadline(deadline)
	// IMAP upstream without the SSL TLV, so Stalwart refuses bearer sign-ins
	// (proxyHeader).
	var ssl *tls.ConnectionState
	if proto == SMTP {
		state := client.ConnectionState()
		ssl = &state
	}
	if _, err := up.Write(proxyHeader(raw.RemoteAddr(), raw.LocalAddr(), ssl)); err != nil {
		_ = client.Close()
		_ = up.Close()
		return
	}

	sess := &session{
		id:                id,
		log:               log,
		proto:             proto,
		addr:              clientAddr(raw),
		cert:              cert,
		macSMTPAnyAddress: s.MacSMTPAnyAddress,
		client:            client,
		raw:               raw,
		cr:                bufio.NewReaderSize(client, 4096),
		cw:                &syncWriter{w: client},
		up:                up,
		ur:                bufio.NewReaderSize(up, 4096),
		lim:               s.Limits,
		accounts:          s.Accounts,
		bindKey:           s.BindTokenKey,
		events:            make(chan event, 8),
		upDone:            make(chan struct{}),
		closed:            make(chan struct{}),
	}
	if !s.track(sess) {
		sess.close(ReasonShutdown)
		return
	}
	defer s.untrack(sess)

	var in *signIn
	switch proto {
	case IMAP:
		go sess.pumpIMAP()
		in, err = sess.imapPreAuth()
	case SMTP:
		go sess.pumpSMTP()
		in, err = sess.smtpPreAuth()
	}
	if err != nil {
		sess.preAuthFailed(err)
		<-sess.closed
		sess.logEnd(start, "")
		return
	}

	// Signed in. Attribute it, or end it.
	var acct *projection.Account
	var lookupErr error
	var deviceID string
	var certKey []byte
	if in != nil {
		acct, lookupErr, deviceID, certKey = in.acct, in.err, in.device, in.certKey
	}
	grant, reason := admit(acct, deviceID, certKey, lookupErr, s.sessionEnds(time.Now()))
	if reason != "" {
		log.Warn("closing a sign-in the front cannot stand behind", "reason", reason, slog.Any("err", lookupErr))
		sess.close(reason)
		sess.logEnd(start, "")
		return
	}
	remove := s.reg.add(grant, sess.close)
	defer remove()
	s.leavePreAuth(ip)
	inPreAuth = false
	_ = client.SetDeadline(time.Time{})
	_ = up.SetDeadline(time.Time{})
	log.Info("signed in", "account", grant.AccountID, "device", grant.DeviceID)

	sess.spliceClient()
	<-sess.closed
	sess.logEnd(start, grant.AccountID)
}

// preAuthFailed tells the client why, where the protocol allows it, and ends
// the session.
func (sess *session) preAuthFailed(err error) {
	limit := errors.Is(err, errLineTooLong) || errors.Is(err, errLiteralTooLong) ||
		errors.Is(err, errCommandTooLong) || errors.Is(err, errTooManyCmds) ||
		errors.Is(err, errTooManyTempFails)
	if limit {
		sess.close(ReasonPreAuthLimits)
		return
	}
	reason := "preauth_ended"
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		reason = "preauth_timeout"
	}
	sess.close(reason)
}

func (s *Server) track(sess *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return false
	}
	s.sessions[sess] = struct{}{}
	return true
}

func (s *Server) untrack(sess *session) {
	s.mu.Lock()
	delete(s.sessions, sess)
	s.mu.Unlock()
}

// Shutdown closes every connection, signed in or not, and waits for their
// goroutines. Listeners are the caller's to close first. Mail clients reconnect.
func (s *Server) Shutdown(ctx context.Context) {
	s.mu.Lock()
	s.closing = true
	all := make([]*session, 0, len(s.sessions))
	for sess := range s.sessions {
		all = append(all, sess)
	}
	s.mu.Unlock()
	for _, sess := range all {
		sess.close(ReasonShutdown)
	}
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// signIn is one sign-in attempt: the account it was looked up as before it was
// forwarded, and the device its forwarded password named.
//
// ⚠ ONE PER ATTEMPT. A client may try LOGIN several times before one succeeds;
// each attempt gets a fresh signIn, and the device is set by the tokenFor that
// wrapped THIS attempt's password, so a device from a failed attempt can never be
// credited to the one that succeeded.
type signIn struct {
	acct *projection.Account
	err  error
	// device is devicecode.DeviceID of the password tokenFor wrapped, or the
	// device resolved by cert key for AUTHENTICATE EXTERNAL, "" for none: the
	// same device the token's MAC covers.
	device string
	// certKey is the certificate key the session stands on: set only for
	// external mode, an IMAP device_code whose row is macos, or a macos SMTP
	// session (the row's key at admission). Nil for passwords and iPhone/iPad.
	certKey []byte
}

func (s *session) signInAs(login string) *signIn {
	a, err := s.lookup(login)
	return &signIn{acct: a, err: err}
}

// clientAddr extracts the client's IP as IPv4 or plain IPv6 with no zone, for
// bindtoken.Attest and Mac liveness checks.
func clientAddr(c net.Conn) netip.Addr {
	if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		if ip, ok := netip.AddrFromSlice(a.IP); ok {
			return ip.Unmap().WithZone("")
		}
	}
	return netip.Addr{}
}

// remoteIP is the key the per-address pre-auth cap counts by: the address for
// IPv4, and the /64 for IPv6, which is what one subscriber is usually given.
// Counting single IPv6 addresses would give a client 2^64 separate caps.
func remoteIP(c net.Conn) string {
	a, ok := c.RemoteAddr().(*net.TCPAddr)
	if !ok {
		return c.RemoteAddr().String()
	}
	if v4 := a.IP.To4(); v4 != nil {
		return v4.String()
	}
	return a.IP.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// sessionEnds is when a session signed in at signedIn ends, by kind.
func (s *Server) sessionEnds(signedIn time.Time) sessionEnds {
	return sessionEnds{
		passthrough: s.passthroughUntil(signedIn),
		device:      deviceUntil(signedIn),
		cert:        certUntil(signedIn),
	}
}

// passthroughUntil is when a pass-through session signed in at signedIn ends:
// PassthroughMaxAge later, less up to a tenth of it at random.
func (s *Server) passthroughUntil(signedIn time.Time) time.Time {
	age := s.PassthroughMaxAge
	if spread := int64(age / 10); spread > 0 {
		age -= time.Duration(rand.Int64N(spread))
	}
	return signedIn.Add(age)
}

// deviceUntil is when a device session signed in at signedIn ends: DeviceMaxAge
// later, plus up to DeviceMaxAgeJitter at random.
func deviceUntil(signedIn time.Time) time.Time {
	return signedIn.Add(DeviceMaxAge + time.Duration(rand.Int64N(int64(DeviceMaxAgeJitter))))
}

// certUntil is when a Mac session (IMAP with a certificate, or SMTP under a
// Mac's code) ends: CertSessionMaxAge later, plus up to CertSessionMaxAgeJitter
// at random (60 to 65 minutes).
func certUntil(signedIn time.Time) time.Time {
	return signedIn.Add(CertSessionMaxAge + time.Duration(rand.Int64N(int64(CertSessionMaxAgeJitter))))
}
