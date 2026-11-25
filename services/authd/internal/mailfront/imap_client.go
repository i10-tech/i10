package mailfront

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/gate"
)

// ── reading one client command before sign-in, by Stalwart's grammar ─────────

// errAmbiguous is a command the front cannot be sure Stalwart would read the
// same way. Before sign-in that ends the connection: an i10 mail client never
// sends one, and the alternative is a guess about whose password Stalwart is
// checking.
var errAmbiguous = errors.New("ambiguous command")

type argKind int

const (
	argString argKind = iota // an atom, a quoted string or a literal
	argOpen                  // (
	argClose                 // )
)

type imapArg struct {
	kind argKind
	val  string
	atom bool // written bare, not quoted or as a literal
}

// imapRequest is one client command as Stalwart's receiver would read it.
type imapRequest struct {
	tag, verb string
	args      []imapArg
}

// str is argument i as a string, if it is one.
func (r *imapRequest) str(i int) (string, bool) {
	if i < len(r.args) && r.args[i].kind == argString {
		return r.args[i].val, true
	}
	return "", false
}

// readIMAPRequest reads one command the way Stalwart's receiver does
// (crates/imap-proto/src/receiver.rs, v1.1.0; v1.2.0 reads the same grammar and
// changed only how a request's size is counted), and refuses anything where
// the two could differ.
//
// What Stalwart does, and what the front does with it:
//
//   - Leading whitespace before a tag is skipped. Same.
//   - A tag ends at a space. Stalwart silently drops a tab or a CR inside one,
//     and takes `*` or `+` as a tag; the front refuses any byte outside
//     0x21-0x7e in a tag, and any RFC 3501 does not allow there (`*`, `+`, `%`,
//     `(`, `)`, `{`, `"`, `\`), so no answer the front passes on can read as
//     untagged or as a continuation.
//   - A verb is up to 15 letters and digits, ended by any whitespace. The front
//     takes only a space, a CRLF or an LF.
//   - Between arguments any whitespace separates. The front takes only a
//     space; a tab, a form feed or a CR not followed by LF is refused.
//   - A quote opens a quoted string, and a `{` a literal, ONLY after whitespace
//     (or `~` alone, literal8). Anywhere else they are ordinary bytes, so
//     `x{20+}` is a word and not a literal. The front refuses a `"` or `{` in
//     the middle of a word, and literal8, outright.
//   - In a quoted string `\"` and `\\` are escapes and any other backslash is
//     kept. The front refuses any other backslash, and a CR or LF inside quotes.
//   - A literal is `{n}` or `{n+}`, up to 15 digits, then whitespace up to LF.
//     The front takes only CRLF or LF after the brace, and n up to MaxLiteral.
//   - An empty quoted string and `{0}` are NIL to Stalwart; the front reads
//     both as "" and writes them back as `{0+}`, which is NIL again.
//
// The front never forwards these bytes. It forwards commands it builds from
// the arguments (rebuild), so Stalwart parses only text the front wrote.
//
// ⚠ BOUNDED IN EVERY DIMENSION: the command, each literal and their number.
// These bytes come from anyone who can open a TCP connection.
func readIMAPRequest(r *bufio.Reader, cw *syncWriter, lim Limits) (*imapRequest, error) {
	p := &imapReader{r: r, lim: lim}
	return p.read(cw)
}

type imapReader struct {
	r        *bufio.Reader
	lim      Limits
	n        int // bytes of this command so far
	literals int
}

func (p *imapReader) next() (byte, error) {
	c, err := p.r.ReadByte()
	if err != nil {
		return 0, err
	}
	p.n++
	if p.n > p.lim.MaxCommand {
		return 0, errCommandTooLong
	}
	return c, nil
}

func isCtl(c byte) bool { return c < 0x20 || c == 0x7f }

func (p *imapReader) read(cw *syncWriter) (*imapRequest, error) {
	req := &imapRequest{}

	// Start: skip whitespace, as Stalwart does.
	c, err := p.next()
	for err == nil && (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f') {
		p.n = 0
		c, err = p.next()
	}
	if err != nil {
		return nil, err
	}

	// Tag.
	var tag []byte
	for c != ' ' {
		if c <= 0x20 || c >= 0x7f || strings.IndexByte(`*+%(){"\`, c) >= 0 || len(tag) >= 128 {
			return nil, errAmbiguous
		}
		tag = append(tag, c)
		if c, err = p.next(); err != nil {
			return nil, err
		}
	}
	req.tag = string(tag)

	// Verb.
	var verb []byte
	for {
		if c, err = p.next(); err != nil {
			return nil, err
		}
		switch {
		case c >= 'a' && c <= 'z':
			c -= 'a' - 'A'
			fallthrough
		case c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			if len(verb) == 15 {
				return nil, errAmbiguous
			}
			verb = append(verb, c)
			continue
		}
		break
	}
	if len(verb) == 0 {
		return nil, errAmbiguous
	}
	req.verb = string(verb)
	switch c {
	case ' ':
	case '\r', '\n':
		return req, p.endLine(c)
	default:
		return nil, errAmbiguous
	}

	// Arguments.
	var atom []byte
	inAtom := false
	afterSpace := true // Stalwart's last_ch is whitespace
	flush := func() {
		if inAtom {
			req.args = append(req.args, imapArg{kind: argString, val: string(atom), atom: true})
			atom, inAtom = atom[:0], false
		}
	}
	for {
		if len(req.args) > 64 {
			return nil, errCommandTooLong
		}
		if c, err = p.next(); err != nil {
			return nil, err
		}
		switch {
		case c == ' ':
			flush()
			afterSpace = true
		case c == '\r' || c == '\n':
			flush()
			return req, p.endLine(c)
		case c == '(' || c == ')':
			// Stalwart leaves last_ch as it was across a parenthesis.
			flush()
			kind := argOpen
			if c == ')' {
				kind = argClose
			}
			req.args = append(req.args, imapArg{kind: kind})
		case c == '"':
			if inAtom || !afterSpace {
				return nil, errAmbiguous
			}
			s, err := p.quoted()
			if err != nil {
				return nil, err
			}
			req.args = append(req.args, imapArg{kind: argString, val: s})
			afterSpace = true
		case c == '{':
			if inAtom || !afterSpace {
				return nil, errAmbiguous
			}
			s, err := p.literal(cw)
			if err != nil {
				return nil, err
			}
			req.args = append(req.args, imapArg{kind: argString, val: s})
			afterSpace = true
		case isCtl(c):
			return nil, errAmbiguous
		default:
			if len(atom) >= 8000 {
				return nil, errLineTooLong
			}
			atom, inAtom = append(atom, c), true
			afterSpace = false
		}
	}
}

// endLine accepts LF, or CR then LF.
func (p *imapReader) endLine(c byte) error {
	if c == '\n' {
		return nil
	}
	c, err := p.next()
	if err != nil {
		return err
	}
	if c != '\n' {
		return errAmbiguous
	}
	return nil
}

func (p *imapReader) quoted() (string, error) {
	var b []byte
	for {
		c, err := p.next()
		if err != nil {
			return "", err
		}
		switch {
		case c == '"':
			return string(b), nil
		case c == '\\':
			e, err := p.next()
			if err != nil {
				return "", err
			}
			if e != '"' && e != '\\' {
				return "", errAmbiguous
			}
			b = append(b, e)
		case c == '\r' || c == '\n' || isCtl(c):
			return "", errAmbiguous
		default:
			if len(b) >= 8000 {
				return "", errLineTooLong
			}
			b = append(b, c)
		}
	}
}

// literal reads `{n}` or `{n+}` after the brace, the line end, and the bytes,
// answering a synchronizing literal's "+" itself.
func (p *imapReader) literal(cw *syncWriter) (string, error) {
	var digits []byte
	sync := true
	for {
		c, err := p.next()
		if err != nil {
			return "", err
		}
		switch {
		case c >= '0' && c <= '9' && sync:
			if len(digits) == 15 {
				return "", errAmbiguous
			}
			digits = append(digits, c)
			continue
		case c == '+' && sync && len(digits) > 0:
			sync = false
			continue
		case c == '}' && len(digits) > 0:
		default:
			return "", errAmbiguous
		}
		break
	}
	n, err := strconv.ParseInt(string(digits), 10, 64)
	if err != nil {
		return "", errAmbiguous
	}
	if n > int64(p.lim.MaxLiteral) {
		return "", errLiteralTooLong
	}
	p.literals++
	if p.literals > 8 || p.n+int(n) > p.lim.MaxCommand {
		return "", errCommandTooLong
	}
	c, err := p.next()
	if err != nil {
		return "", err
	}
	if c != '\r' && c != '\n' {
		return "", errAmbiguous
	}
	if err := p.endLine(c); err != nil {
		return "", err
	}
	if sync {
		if err := cw.WriteString("+ Ready for literal data\r\n"); err != nil {
			return "", err
		}
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(p.r, b); err != nil {
		return "", err
	}
	p.n += int(n)
	return string(b), nil
}

// ── building what Stalwart is sent ───────────────────────────────────────────

// literal renders s as a non-synchronizing literal: unambiguous to any parser.
func literal(s string) string { return fmt.Sprintf("{%d+}\r\n%s", len(s), s) }

// rebuildID writes an ID command from the client's arguments: NIL, or a list of
// up to 30 string pairs whose values may be NIL. Anything else is refused.
func rebuildID(args []imapArg) (string, bool) {
	if len(args) == 1 && isNil(args[0]) {
		return "ID NIL", true
	}
	if len(args) < 2 || args[0].kind != argOpen || args[len(args)-1].kind != argClose {
		return "", false
	}
	inner := args[1 : len(args)-1]
	if len(inner)%2 != 0 || len(inner) > 60 {
		return "", false
	}
	var b strings.Builder
	b.WriteString("ID (")
	for i, a := range inner {
		if a.kind != argString {
			return "", false
		}
		if i > 0 {
			b.WriteByte(' ')
		}
		if i%2 == 1 && isNil(a) {
			b.WriteString("NIL")
			continue
		}
		b.WriteString(literal(a.val))
	}
	b.WriteString(")")
	return b.String(), true
}

func isNil(a imapArg) bool { return a.kind == argString && a.atom && strings.EqualFold(a.val, "NIL") }

// ── the client side before sign-in ───────────────────────────────────────────

// imapPreAuth runs the client side until a sign-in succeeds, returning the row
// that sign-in was looked up as (nil when none could be), or an error when the
// session ended first.
//
// ⚠ LOCK-STEP: each command is sent only after Stalwart has answered the one
// before it, so every local answer lands in order.
//
// ⚠ AN ALLOWLIST, AND EVERY COMMAND REBUILT. Before sign-in Stalwart is sent
// CAPABILITY, NOOP, LOGOUT, ID, LOGIN and AUTHENTICATE PLAIN, each written by
// the front from what it read, under a random tag of its own. Nothing a client
// sent reaches Stalwart as sent, so there is no difference between two parsers
// left to exploit: whatever Stalwart signs in is exactly what the front
// attributes. Every other command is answered here and never forwarded.
func (s *session) imapPreAuth() (*signIn, error) {
	for n := 0; ; n++ {
		if n >= s.lim.MaxCommands {
			return nil, errTooManyCmds
		}
		req, err := readIMAPRequest(s.cr, s.cw, s.lim)
		if err != nil {
			if errors.Is(err, errAmbiguous) {
				_ = s.cw.WriteString("* BYE Invalid command.\r\n")
			}
			return nil, err
		}
		tag := req.tag
		switch req.verb {
		case "CAPABILITY", "NOOP", "LOGOUT":
			if len(req.args) != 0 {
				if err := s.cw.WriteString(tag + " BAD Unexpected arguments.\r\n"); err != nil {
					return nil, err
				}
				continue
			}
			if _, err := s.send(tag, req.verb); err != nil {
				return nil, err
			}
		case "ID":
			cmd, ok := rebuildID(req.args)
			if !ok {
				if err := s.cw.WriteString(tag + " BAD Invalid arguments.\r\n"); err != nil {
					return nil, err
				}
				continue
			}
			s.logID(req.args)
			if _, err := s.send(tag, cmd); err != nil {
				return nil, err
			}
		case "LOGIN":
			user, ok1 := req.str(0)
			pass, ok2 := req.str(1)
			if len(req.args) != 2 || !ok1 || !ok2 {
				if err := s.cw.WriteString(tag + " BAD Invalid arguments.\r\n"); err != nil {
					return nil, err
				}
				continue
			}
			in := s.signInAs(user)
			fwd, err := s.tokenFor(in)(pass)
			if err != nil {
				if err := s.signInUnavailable(tag, err); err != nil {
					return nil, err
				}
				continue
			}
			up := newUpstreamTag()
			s.setPending(up)
			ok, err := s.sendAs(up, tag, "LOGIN "+literal(user)+" "+literal(fwd))
			if err != nil || ok {
				return in, err
			}
			s.setPending("")
		case "AUTHENTICATE":
			mech, ok := req.str(0)
			if !ok || len(req.args) < 1 || len(req.args) > 2 {
				if err := s.cw.WriteString(tag + " BAD Unsupported mechanism.\r\n"); err != nil {
					return nil, err
				}
				continue
			}
			switch strings.ToUpper(mech) {
			case mechPlain:
				in, ok, err := s.imapAuthPlain(tag, req)
				if err != nil || ok {
					return in, err
				}
				s.setPending("")
			case mechExternal:
				if s.cert == nil {
					if err := s.cw.WriteString(tag + " BAD Unsupported mechanism.\r\n"); err != nil {
						return nil, err
					}
					continue
				}
				in, ok, err := s.imapAuthExternal(tag, req)
				if err != nil || ok {
					return in, err
				}
				s.setPending("")
			default:
				if err := s.cw.WriteString(tag + " BAD Unsupported mechanism.\r\n"); err != nil {
					return nil, err
				}
			}
		case "STARTTLS":
			// The client is already on TLS, with the front. Stalwart's listener
			// has none to offer.
			if err := s.cw.WriteString(tag + " BAD " + startTLSAnswer + "\r\n"); err != nil {
				return nil, err
			}
		default:
			if err := s.cw.WriteString(tag + " BAD Command not allowed before sign-in.\r\n"); err != nil {
				return nil, err
			}
		}
	}
}

// send forwards one rebuilt command under a fresh tag and waits for its answer.
func (s *session) send(clientTag, cmd string) (bool, error) {
	return s.sendAs(newUpstreamTag(), clientTag, cmd)
}

func (s *session) sendAs(up, clientTag, cmd string) (bool, error) {
	s.expect(up, clientTag)
	if err := s.forward([]byte(up + " " + cmd + "\r\n")); err != nil {
		return false, err
	}
	return s.awaitTagged(up)
}

// imapAuthPlain runs AUTHENTICATE PLAIN, with SASL-IR or with a continuation.
func (s *session) imapAuthPlain(tag string, req *imapRequest) (*signIn, bool, error) {
	up := newUpstreamTag()
	if len(req.args) == 2 {
		ir, ok := req.str(1)
		if !ok {
			return nil, false, s.cw.WriteString(tag + " BAD Invalid arguments.\r\n")
		}
		res := parsePlain(ir)
		if !res.ok || res.foreignAuthzid {
			// Not a response the front can stand behind. Nothing is sent.
			return nil, false, s.cw.WriteString(tag + " NO Authentication failed.\r\n")
		}
		in := s.signInAs(res.authcid)
		fwd, err := plainWithToken(ir, s.tokenFor(in))
		if err != nil {
			return nil, false, s.signInUnavailable(tag, err)
		}
		s.setPending(up)
		ok, err = s.sendAs(up, tag, "AUTHENTICATE PLAIN "+fwd)
		return in, ok, err
	}

	s.setPending(up)
	s.expect(up, tag)
	if err := s.forward([]byte(up + " AUTHENTICATE PLAIN\r\n")); err != nil {
		return nil, false, err
	}
	var in *signIn
	for step := 0; ; step++ {
		ev, err := s.await()
		if err != nil {
			return nil, false, err
		}
		if !ev.cont {
			if ev.tag != up {
				continue
			}
			return in, ev.status == "OK", nil
		}
		if step > 0 {
			// PLAIN has one response. A second continuation is not PLAIN.
			if err := s.forward([]byte("*\r\n")); err != nil {
				return nil, false, err
			}
			continue
		}
		line, err := readLine(s.cr, s.lim.MaxLine)
		if err != nil {
			return nil, false, err
		}
		resp := string(trimEOL(line))
		res := parsePlain(resp)
		if resp == "*" || !res.ok || res.foreignAuthzid {
			// The client cancelled, or sent something the front cannot stand
			// behind: cancel it, and Stalwart answers the tag.
			if err := s.forward([]byte("*\r\n")); err != nil {
				return nil, false, err
			}
			continue
		}
		in = s.signInAs(res.authcid)
		fwd, err := plainWithToken(resp, s.tokenFor(in))
		if err != nil {
			// No key or no lookup: cancel, and Stalwart answers the tag.
			s.log.Error("sign-in not forwarded", slog.Any("err", err))
			fwd = "*"
		}
		if err := s.forward([]byte(fwd + "\r\n")); err != nil {
			return nil, false, err
		}
	}
}

// imapAuthExternal runs AUTHENTICATE EXTERNAL for a 993 connection whose client
// certificate verified (#383 PR 3). It supports both an initial response
// (including RFC 4959's "=") and a continuation ("+ " then one line; "*"
// cancels). It looks up the device by SPKI hash and its account, enforces the
// gate and Mac platform, and forwards an AUTHENTICATE PLAIN of its own carrying
// an external bind token.
func (s *session) imapAuthExternal(tag string, req *imapRequest) (*signIn, bool, error) {
	var authzid string
	if len(req.args) == 2 {
		ir, ok := req.str(1)
		if !ok {
			return nil, false, s.cw.WriteString(tag + " BAD Invalid arguments.\r\n")
		}
		authzid, ok = parseExternal(ir, true)
		if !ok {
			return nil, false, s.cw.WriteString(tag + " NO [AUTHENTICATIONFAILED] Authentication failed.\r\n")
		}
	} else {
		if err := s.cw.WriteString("+ \r\n"); err != nil {
			return nil, false, err
		}
		line, err := readLine(s.cr, s.lim.MaxLine)
		if err != nil {
			return nil, false, err
		}
		resp := string(trimEOL(line))
		if resp == "*" {
			return nil, false, s.cw.WriteString(tag + " BAD Authentication cancelled.\r\n")
		}
		var ok bool
		authzid, ok = parseExternal(resp, false)
		if !ok {
			return nil, false, s.cw.WriteString(tag + " NO [AUTHENTICATIONFAILED] Authentication failed.\r\n")
		}
	}

	dev, err := s.deviceByCertKey(s.cert.key)
	if err != nil {
		return nil, false, s.signInUnavailable(tag, err)
	}
	if dev == nil || dev.Platform != gate.Macos {
		return nil, false, s.cw.WriteString(tag + " NO [AUTHENTICATIONFAILED] Authentication failed.\r\n")
	}
	acct, err := s.lookup(dev.Email)
	if err != nil {
		return nil, false, s.signInUnavailable(tag, err)
	}
	if acct == nil || gate.Refusal(acct) != "" || gate.DeviceRefusal(dev, acct, s.cert.key) != "" {
		return nil, false, s.cw.WriteString(tag + " NO [AUTHENTICATIONFAILED] Authentication failed.\r\n")
	}
	if authzid != "" && normaliseLogin(authzid) != normaliseLogin(acct.Email) {
		return nil, false, s.cw.WriteString(tag + " NO [AUTHENTICATIONFAILED] Authentication failed.\r\n")
	}
	if s.bindKey == nil {
		return nil, false, s.signInUnavailable(tag, errNoBindKey)
	}
	tok, err := bindtoken.WrapExternal(*s.bindKey, acct.ClerkUserID, dev.ID, bindtoken.Attest{
		Protocol: bindtoken.IMAP,
		Addr:     s.addr,
		CertKey:  s.cert.key,
		CertCN:   s.cert.cn,
	}, time.Now())
	if err != nil {
		return nil, false, s.signInUnavailable(tag, err)
	}

	in := &signIn{acct: acct, device: dev.ID, certKey: bytes.Clone(s.cert.key)}
	up := newUpstreamTag()
	s.setPending(up)
	ok, err := s.sendAs(up, tag, "AUTHENTICATE PLAIN "+encodePlain("", acct.Email, tok))
	return in, ok, err
}

// awaitTagged waits for the tagged completion of up, the front's own tag,
// ignoring continuations. It reports whether it was OK.
func (s *session) awaitTagged(up string) (bool, error) {
	for {
		ev, err := s.await()
		if err != nil {
			return false, err
		}
		if !ev.cont && ev.tag == up {
			return ev.status == "OK", nil
		}
	}
}

func (s *session) forward(b []byte) error {
	_, err := s.up.Write(b)
	return err
}

// logID records the client's IMAP ID fields (RFC 2971), which later PRs name
// devices from. Values are clipped and stripped of control characters.
func (s *session) logID(args []imapArg) {
	if len(args) < 2 || args[0].kind != argOpen {
		return
	}
	fields := make([]any, 0, 24)
	for i := 1; i+1 < len(args) && len(fields) < 2*12; i += 2 {
		if args[i].kind != argString || args[i+1].kind != argString {
			break
		}
		fields = append(fields, "id."+clip(strings.ToLower(args[i].val), 32), clip(args[i+1].val, 128))
	}
	if len(fields) > 0 {
		s.log.Info("imap id", fields...)
	}
}

func clip(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > n {
		s = s[:n]
	}
	return s
}

// signInUnavailable answers a sign-in the front did not forward: it has no key
// to sign its token with, or no account to sign it for because the lookup
// failed. Temporarily unavailable, which mail clients retry, never "wrong
// password", which makes them ask the person.
func (s *session) signInUnavailable(tag string, err error) error {
	s.log.Error("sign-in not forwarded", slog.Any("err", err))
	return s.cw.WriteString(tag + " NO [UNAVAILABLE] Sign-in is temporarily unavailable.\r\n")
}
