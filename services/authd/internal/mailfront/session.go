package mailfront

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// Limits bound everything the front holds for a connection before it has
// signed in, which is when its bytes come from anyone on the internet.
type Limits struct {
	// MaxLine is the longest client line, CRLF included. SMTP's AUTH line is
	// allowed 12288 octets by RFC 4954, so that is the floor in practice.
	MaxLine int
	// MaxLiteral is the largest IMAP literal accepted before sign-in. A user name
	// or a password is far below it.
	MaxLiteral int
	// MaxCommand is the most bytes one IMAP command may carry, literals included.
	MaxCommand int
	// MaxCommands is how many commands a client may send before signing in.
	MaxCommands int
	// PreAuth is the longest a connection may take from accept to signed in, the
	// TLS handshake included.
	PreAuth time.Duration
	// Handshake bounds the TLS handshake alone. Mac Mail's account check can sit
	// behind a keychain prompt for many seconds (mail-device-binding.md 3).
	Handshake time.Duration
}

// DefaultLimits are the production bounds.
var DefaultLimits = Limits{
	MaxLine:     12288 + 2,
	MaxLiteral:  8192,
	MaxCommand:  16384,
	MaxCommands: 64,
	PreAuth:     2 * time.Minute,
	Handshake:   30 * time.Second,
}

var (
	errLineTooLong      = errors.New("line too long")
	errLiteralTooLong   = errors.New("literal too long")
	errCommandTooLong   = errors.New("command too long")
	errTooManyCmds      = errors.New("too many commands before sign-in")
	errTooManyTempFails = errors.New("too many temporary authentication failures")
	errUpstreamGone     = errors.New("upstream closed")
	errProtocol         = errors.New("protocol error")
)

// event is what the server side reports to the client side before sign-in.
type event struct {
	// cont is an IMAP "+" or an SMTP 334.
	cont bool
	// tag and status: an IMAP tagged completion (status upper-cased).
	tag, status string
	// code: an SMTP reply's code.
	code int
	// text is the continuation's payload (SMTP 334's base64 prompt).
	text string
}

// session is one client connection and its upstream connection to Stalwart.
type session struct {
	id                uint64
	log               *slog.Logger
	proto             Protocol
	addr              netip.Addr
	cert              *verifiedCert
	macSMTPAnyAddress bool
	macTempFails      int
	client            net.Conn // the TLS connection
	raw               net.Conn // the TCP connection under it
	cr                *bufio.Reader
	cw                *syncWriter
	up                net.Conn
	ur                *bufio.Reader
	lim               Limits
	accounts          Accounts
	bindKey           *bindtoken.Key

	events chan event
	// upDone is closed when the server side stops reading before sign-in.
	upDone chan struct{}

	mu          sync.Mutex
	pendingAuth string // the sign-in's upstream IMAP tag, or smtpPending
	authed      bool
	// upTag and clientTag are the IMAP command in flight before sign-in: the
	// tag the front sent it under, and the client's own, which the answer gets
	// back. Empty when nothing is in flight.
	upTag, clientTag string

	closeOnce sync.Once
	closed    chan struct{}
	reason    string
}

// syncWriter serialises writes to the client: before sign-in both the server
// side (responses) and the client side (local answers, literal continuations)
// write to it.
type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}

func (s *syncWriter) WriteString(str string) error {
	_, err := s.Write([]byte(str))
	return err
}

// close ends the session once, for a reason that is logged.
func (s *session) close(reason string) {
	s.closeOnce.Do(func() {
		s.reason = reason
		close(s.closed)
		// ⚠ THE TCP CONNECTION, NOT THE TLS ONE. tls.Conn.Close sends a
		// close_notify first and waits up to five seconds for a peer that is not
		// reading, and the sweep closes revoked connections one after another.
		// A revoked session gets no goodbye.
		if s.raw != nil {
			_ = s.raw.Close()
		}
		_ = s.client.Close()
		_ = s.up.Close()
	})
}

// setPending marks the auth command whose success the server side waits for.
func (s *session) setPending(tag string) {
	s.mu.Lock()
	s.pendingAuth = tag
	s.mu.Unlock()
}

// expect records the IMAP command about to be sent under upTag for the
// client's tag.
func (s *session) expect(upTag, clientTag string) {
	s.mu.Lock()
	s.upTag, s.clientTag = upTag, clientTag
	s.mu.Unlock()
}

// answering takes the client's tag for a tagged answer to upTag, or reports
// that nothing the front sent is waiting for one.
func (s *session) answering(upTag string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.authed {
		// After sign-in the client tags its own commands.
		return upTag, true
	}
	if s.upTag == "" || upTag != s.upTag {
		return "", false
	}
	client := s.clientTag
	s.upTag, s.clientTag = "", ""
	return client, true
}

// newUpstreamTag is a tag no client can guess or reuse: "mf" and 16 random
// hex digits.
func newUpstreamTag() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "mf" + hex.EncodeToString(b[:])
}

// authSucceeded is called by the server side on what looks like a successful
// sign-in. It reports whether that was the one sign-in this session expects.
// Anything else (no sign-in in flight, or one already done) closes the session.
func (s *session) authSucceeded(tag string, structural bool) bool {
	s.mu.Lock()
	expected := !s.authed && s.pendingAuth != "" && s.pendingAuth == tag
	if expected {
		s.authed = true
	}
	s.mu.Unlock()
	if expected {
		return true
	}
	if structural {
		s.close(ReasonSecondSignIn)
	}
	return false
}

// await waits for the server side's next event before sign-in.
func (s *session) await() (event, error) {
	select {
	case ev := <-s.events:
		return ev, nil
	case <-s.upDone:
		// Drain an event that raced the close.
		select {
		case ev := <-s.events:
			return ev, nil
		default:
		}
		return event{}, errUpstreamGone
	case <-s.closed:
		return event{}, net.ErrClosed
	}
}

// emit hands an event to the client side, or drops it if the session ended.
func (s *session) emit(ev event) {
	select {
	case s.events <- ev:
	case <-s.closed:
	}
}

// lookup reads the account a login names, bounded by its own timeout.
func (s *session) lookup(login string) (*projection.Account, error) {
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	return s.accounts.AccountByLogin(ctx, login)
}

func (s *session) deviceGate(id string) (*projection.Device, error) {
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	return s.accounts.DeviceGate(ctx, id)
}

func (s *session) deviceByCertKey(key []byte) (*projection.Device, error) {
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	return s.accounts.DeviceByCertKey(ctx, key)
}

func (s *session) macLive(deviceID string, at netip.Prefix, key []byte) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	return s.accounts.MacLive(ctx, deviceID, at, key)
}

func (s *session) bindProtocol() bindtoken.Protocol {
	if s.proto == SMTP {
		return bindtoken.SMTP
	}
	return bindtoken.IMAP
}

// startTLSAnswer is the front's own answer to STARTTLS on both ports (the client
// is already on TLS, with the front). Stalwart words its answer differently
// ("Already in TLS mode."), so this text is how infra/k8s/i10/stalwart/
// bootstrap.sh --verify tells that 993 and 465 are answered by the front.
//
// ⚠ CHANGING THE TEXT BREAKS THAT CHECK. Change both together.
const startTLSAnswer = "Connection is already encrypted (i10 mail front)."

// errNoBindKey: the front has no key to sign the token authd requires, so it
// forwards nothing and answers the sign-in itself.
var errNoBindKey = errors.New("mailfront: no bind token key")

// errLookupDown: the projection could not say who the login is, so there is no
// account to mint a token for. Forwarded raw, authd would answer "wrong
// password" and mail clients would ask the person; answered here, it is
// "temporarily unavailable", which they retry.
var errLookupDown = errors.New("mailfront: the projection lookup failed")

// tokenFor returns how the password of a sign-in looked up as in is forwarded:
// behind a fresh token for the account the front credits the connection to
// (internal/bindtoken), which is what authd checks the bind's DN against. When
// the password is a device code, it records the device on in: the device the
// token covers, and the one admit puts in the Grant.
//
// ⚠ NO ACCOUNT, NO TOKEN. A login the projection does not know (a `%` master
// login, Stalwart's recovery admin) or a lookup that failed is forwarded as it
// came, raw: authd refuses it, and a sign-in Stalwart accepts without authd
// cannot be attributed and is closed by admit. The front never mints a token for
// an account it did not look up.
func (s *session) tokenFor(in *signIn) func(password string) (string, error) {
	return func(password string) (string, error) {
		if s.bindKey == nil {
			return "", errNoBindKey
		}
		if in != nil && in.err != nil {
			return "", errLookupDown
		}
		if in == nil || in.acct == nil {
			return password, nil
		}
		if password == "" {
			// Empty password is not wrapped: authd refuses it as empty_password
			// before bindtoken.Unwrap (RFC 4513 §5.1.2).
			return "", nil
		}
		at := bindtoken.Attest{
			Protocol: s.bindProtocol(),
			Addr:     s.addr,
		}
		devID := devicecode.DeviceID(password)
		// ⚠ REVISION 5 + MAC INSTALL GRACE:
		// On IMAP, a macos device_code carries the verified client certificate
		// when one arrived in the TLS handshake. When no certificate arrived
		// and the Mac is still inside its initial 10-minute install grace (no
		// certificate session recorded yet), the token stays without a
		// certificate (so authd applies grace rules and writes no liveness row),
		// while the Grant still stands on the row's key and caps session age to
		// the time remaining in the grace window. Password sign-ins and
		// iPhone/iPad codes ignore any presented certificate completely, and
		// SMTP tokens never carry a certificate key.
		if s.proto == IMAP && devID != "" {
			dev, err := s.deviceGate(devID)
			if err != nil {
				return "", errLookupDown
			}
			if dev != nil && dev.Platform == gate.Macos {
				switch {
				case s.cert != nil:
					at.CertKey = s.cert.key
					at.CertCN = s.cert.cn
					in.certKey = bytes.Clone(s.cert.key)
				case dev.MacInstallGrace && len(dev.CertKey) > 0:
					in.certKey = bytes.Clone(dev.CertKey)
					in.graceUntil = graceDeadline(time.Now(), dev.MacInstallGraceLeft)
				}
			}
		}
		wrapped, err := bindtoken.Wrap(*s.bindKey, in.acct.ClerkUserID, password, at, time.Now())
		if err != nil {
			return "", err
		}
		in.device = devID
		return wrapped, nil
	}
}

// lookupTimeout bounds the one projection read a sign-in costs. authd's own
// projection lookup has to succeed for the sign-in to, so a slow one here is a
// slow one there.
const lookupTimeout = 3 * time.Second

// readLine reads one line, its ending included, refusing more than max bytes.
func readLine(r *bufio.Reader, max int) ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.ReadSlice('\n')
		if len(line)+len(chunk) > max {
			return nil, errLineTooLong
		}
		line = append(line, chunk...)
		switch {
		case err == nil:
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default:
			return line, err
		}
	}
}

// trimEOL strips a trailing CRLF or LF.
func trimEOL(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\n' {
		b = b[:n-1]
		if n := len(b); n > 0 && b[n-1] == '\r' {
			b = b[:n-1]
		}
	}
	return b
}

// spliceClient copies the client's bytes to Stalwart once the session has
// signed in, starting with whatever the pre-auth reader had already buffered.
// The server-to-client direction is the protocol's own pump. Nothing on this
// side is parsed after sign-in.
func (s *session) spliceClient() {
	if n := s.cr.Buffered(); n > 0 {
		b, _ := s.cr.Peek(n)
		if _, err := s.up.Write(b); err != nil {
			s.close("upstream_write")
			return
		}
		_, _ = s.cr.Discard(n)
	}
	s.cr = nil
	buf := make([]byte, copyBuffer)
	_, err := io.CopyBuffer(s.up, onlyReader{s.client}, buf)
	if err != nil && !errors.Is(err, net.ErrClosed) {
		s.close("client_error")
		return
	}
	// The client is done sending. Let Stalwart finish its answer (a LOGOUT's
	// BYE, a QUIT's 221) and close, but not forever.
	if tc, ok := s.up.(interface{ CloseWrite() error }); ok {
		_ = tc.CloseWrite()
	}
	_ = s.up.SetReadDeadline(time.Now().Add(5 * time.Second))
}

// copyBuffer is each direction's buffer after sign-in. Small, because most of
// these connections sit idle in IDLE all day and each one holds two for its
// whole life. A large APPEND or FETCH only takes more reads.
const copyBuffer = 4 << 10

// onlyReader hides WriteTo/ReadFrom so io.CopyBuffer uses the buffer given.
type onlyReader struct{ io.Reader }

// pumpRaw copies Stalwart's bytes to the client after sign-in through scan,
// which may stop the copy (it names the reason) before a forbidden line.
func (s *session) pumpRaw(r io.Reader, scan func([]byte) (int, string)) {
	buf := make([]byte, copyBuffer)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			cut, reason := scan(buf[:n])
			if cut >= 0 {
				if cut > 0 {
					_, _ = s.cw.Write(buf[:cut])
				}
				s.close(reason)
				return
			}
			if _, werr := s.cw.Write(buf[:n]); werr != nil {
				s.close("client_write")
				return
			}
		}
		if err != nil {
			s.close("upstream_closed")
			return
		}
	}
}

// drainBuffered is the pump's reader after sign-in: what the pre-auth reader
// already holds first, then the connection itself, so the pre-auth buffer is
// not kept for the life of an idle session.
func drainBuffered(br *bufio.Reader, conn net.Conn) io.Reader {
	n := br.Buffered()
	if n == 0 {
		return conn
	}
	b, _ := br.Peek(n)
	return io.MultiReader(bytes.NewReader(bytes.Clone(b)), conn)
}

// logEnd logs how the session ended.
func (s *session) logEnd(start time.Time, account string) {
	s.log.Info("connection closed", "reason", s.reason, "account", account,
		"duration", time.Since(start).Round(time.Millisecond).String())
}
