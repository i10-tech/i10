package mailfront

import (
	"bufio"
	"bytes"
	"log/slog"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/devicecode"
	"github.com/i10-tech/i10/services/authd/internal/gate"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

const (
	smtpPending = "smtp-auth"
	// maxMacTempFails caps how many Mac liveness 454 answers the front sends on
	// one SMTP connection before closing it (revision 5).
	maxMacTempFails = 3
)

// smtpPreAuth runs the client side of SMTP submission until AUTH succeeds.
//
// ⚠ LOCK-STEP, AS IN IMAP: one command, then its whole reply, then the next. A
// client that pipelines is simply served in order.
//
// ⚠ AN ALLOWLIST, AND EVERY COMMAND REBUILT, AS IN IMAP. Stalwart's verb reader
// (crates/smtp-proto, Rfc5321Parser::hashed_value) skips leading spaces and
// every CR, and ends the verb at any whitespace, so ` AUTH`, `AUTH<TAB>PLAIN`
// and `AU<CR>TH` all reach it as AUTH. The front therefore never forwards a
// client's line: it reads it strictly (parseSMTPCommand), and sends Stalwart
// only EHLO, HELO, NOOP, RSET, QUIT and AUTH, written by itself. Anything else
// is answered here.
func (s *session) smtpPreAuth() (*signIn, error) {
	// The greeting first, so a client that talks before it is not answered with
	// the greeting as if it were the reply to its first command.
	if _, err := s.await(); err != nil {
		return nil, err
	}
	for n := 0; ; n++ {
		if n >= s.lim.MaxCommands {
			return nil, errTooManyCmds
		}
		line, err := readLine(s.cr, s.lim.MaxLine)
		if err != nil {
			return nil, err
		}
		verb, args, ok := parseSMTPCommand(line)
		if !ok {
			_ = s.cw.WriteString("500 5.5.2 Invalid command.\r\n")
			return nil, errAmbiguous
		}
		var cmd string
		switch verb {
		case "AUTH":
			in, ok, err := s.smtpAuth(args)
			if err != nil || ok {
				return in, err
			}
			s.setPending("")
			continue
		case "EHLO", "HELO":
			if !validHeloName(args) {
				if err := s.cw.WriteString("501 5.5.4 Invalid domain name.\r\n"); err != nil {
					return nil, err
				}
				continue
			}
			cmd = verb + " " + args
		case "NOOP", "RSET", "QUIT":
			cmd = verb
		case "STARTTLS":
			if err := s.cw.WriteString("503 5.5.1 " + startTLSAnswer + "\r\n"); err != nil {
				return nil, err
			}
			continue
		default:
			// MAIL, RCPT, DATA, BDAT, VRFY, EXPN, HELP and anything unknown. Stalwart
			// refuses mail before AUTH on 465 anyway; DATA and BDAT would also be
			// followed by a message this reader would take for commands.
			if err := s.cw.WriteString("503 5.5.1 You must authenticate first.\r\n"); err != nil {
				return nil, err
			}
			continue
		}
		if err := s.forward([]byte(cmd + "\r\n")); err != nil {
			return nil, err
		}
		if _, err := s.await(); err != nil {
			return nil, err
		}
	}
}

// parseSMTPCommand reads a command line strictly: no control byte anywhere but
// the CRLF (or LF) that ends it, no leading space, a verb of letters only, and
// at most one space before its arguments. It returns the verb upper-cased.
func parseSMTPCommand(line []byte) (verb, args string, ok bool) {
	body := trimEOL(line)
	for _, c := range body {
		if isCtl(c) {
			return "", "", false
		}
	}
	v, a, _ := strings.Cut(string(body), " ")
	if v == "" || len(v) > 16 || strings.HasPrefix(a, " ") {
		return "", "", false
	}
	for i := 0; i < len(v); i++ {
		if c := v[i] | 0x20; c < 'a' || c > 'z' {
			return "", "", false
		}
	}
	return strings.ToUpper(v), a, true
}

// validHeloName is one printable word, as long as a domain may be.
func validHeloName(s string) bool {
	if s == "" || len(s) > 255 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; c <= 0x20 || c >= 0x7f {
			return false
		}
	}
	return true
}

// smtpAuth runs one AUTH exchange: PLAIN or LOGIN, initial response or not.
//
// ⚠ THE FRONT OWNS THE WHOLE EXCHANGE AND FORWARDS ONCE (#383 PR 3). Answering
// every 334 locally means nothing reaches Stalwart until the credentials have
// arrived and every pre-check (the login lookup, a Mac's device row and its
// liveness row) has run. Our own faults and a missing Mac liveness row can
// therefore be answered 454 4.7.0 cleanly, whereas cancelling a mid-exchange
// AUTH LOGIN against Stalwart produced a permanent 501. Once ready, the front
// forwards ONE AUTH PLAIN <initial response> of its own (LOGIN rewritten as
// PLAIN).
func (s *session) smtpAuth(args string) (*signIn, bool, error) {
	mech, ir, hasIR := strings.Cut(args, " ")
	mech = strings.ToUpper(mech)
	if hasIR && (ir == "" || strings.Contains(ir, " ")) {
		return nil, false, s.cw.WriteString("501 5.5.4 Syntax: AUTH mechanism [initial-response]\r\n")
	}
	if !supportedMech(mech, true) {
		return nil, false, s.cw.WriteString("504 5.5.4 Unrecognized authentication type.\r\n")
	}

	readResp := func() (resp string, cancelled bool, err error) {
		line, err := readLine(s.cr, s.lim.MaxLine)
		if err != nil {
			return "", false, err
		}
		body := trimEOL(line)
		for _, c := range body {
			if isCtl(c) {
				_ = s.cw.WriteString("500 5.5.2 Invalid command.\r\n")
				return "", false, errAmbiguous
			}
		}
		resp = strings.TrimSpace(string(body))
		if resp == "*" {
			return "", true, nil
		}
		return resp, false, nil
	}

	var authzid, authcid, password string
	switch mech {
	case mechPlain:
		resp := strings.TrimSpace(ir)
		if !hasIR {
			if err := s.cw.WriteString("334 \r\n"); err != nil {
				return nil, false, err
			}
			var cancelled bool
			var err error
			resp, cancelled, err = readResp()
			if err != nil {
				return nil, false, err
			}
			if cancelled {
				return nil, false, s.cw.WriteString("501 5.7.0 Authentication cancelled.\r\n")
			}
		}
		var ok, foreign bool
		authzid, authcid, password, ok, foreign = decodePlain(resp)
		if !ok || foreign {
			return nil, false, s.cw.WriteString("535 5.7.8 Authentication credentials invalid.\r\n")
		}
	case mechLogin:
		userResp := strings.TrimSpace(ir)
		if !hasIR {
			if err := s.cw.WriteString("334 VXNlcm5hbWU6\r\n"); err != nil {
				return nil, false, err
			}
			var cancelled bool
			var err error
			userResp, cancelled, err = readResp()
			if err != nil {
				return nil, false, err
			}
			if cancelled {
				return nil, false, s.cw.WriteString("501 5.7.0 Authentication cancelled.\r\n")
			}
		}
		ures := parseLoginUser(userResp)
		if !ures.ok {
			return nil, false, s.cw.WriteString("535 5.7.8 Authentication credentials invalid.\r\n")
		}
		if err := s.cw.WriteString("334 UGFzc3dvcmQ6\r\n"); err != nil {
			return nil, false, err
		}
		passResp, cancelled, err := readResp()
		if err != nil {
			return nil, false, err
		}
		if cancelled {
			return nil, false, s.cw.WriteString("501 5.7.0 Authentication cancelled.\r\n")
		}
		rawPass, ok := decodeSASL(passResp)
		if !ok || len(rawPass) == 0 || bytes.IndexByte(rawPass, 0) >= 0 {
			clear(rawPass)
			return nil, false, s.cw.WriteString("535 5.7.8 Authentication credentials invalid.\r\n")
		}
		authcid = ures.authcid
		password = string(rawPass)
		clear(rawPass)
	}

	if password == "" {
		return nil, false, s.cw.WriteString("535 5.7.8 Authentication credentials invalid.\r\n")
	}
	if s.bindKey == nil {
		s.log.Error("sign-in not forwarded", slog.Any("err", errNoBindKey))
		return nil, false, s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n")
	}

	in := s.signInAs(authcid)
	if in.err != nil {
		s.log.Error("sign-in not forwarded", slog.Any("err", in.err))
		return nil, false, s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n")
	}

	// ⚠ MAC LIVENESS PRE-CHECK (revision 5 + PR 4 install grace): the front
	// answers 454 ONLY when the account row, gate.Refusal, the device row and
	// gate.DeviceRefusal (person, address, workspace, non-null key) all pass,
	// the Mac is outside its initial 10-minute install grace, and ONLY the
	// liveness row is missing. Everything else is forwarded so authd's throttle
	// and refusal decide, and an unknown device id looks like any wrong password.
	if in.acct != nil && gate.Refusal(in.acct) == "" {
		if devID := devicecode.DeviceID(password); devID != "" {
			dev, err := s.deviceGate(devID)
			if err != nil {
				s.log.Error("sign-in not forwarded", slog.Any("err", err))
				return nil, false, s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n")
			}
			if dev != nil && dev.Platform == gate.Macos && gate.DeviceRefusal(dev, in.acct, dev.CertKey) == "" {
				if dev.MacInstallGrace {
					// A new Mac with no certificate session yet forwards its code
					// so macOS account validation succeeds, for at most the time
					// left in its grace window.
					in.graceUntil = graceDeadline(time.Now(), dev.MacInstallGraceLeft)
				} else if answered, err := s.deferWithoutMacLiveness(dev, in.acct); answered {
					return nil, false, err
				}
				// Record the row's key at admission so a key change closes this
				// SMTP session at the next poll, and it ends at cert_session_max_age
				// (or the end of the install grace).
				in.certKey = bytes.Clone(dev.CertKey)
			}
		}
	}

	fwd, err := s.tokenFor(in)(password)
	if err != nil {
		s.log.Error("sign-in not forwarded", slog.Any("err", err))
		return nil, false, s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n")
	}

	s.setPending(smtpPending)
	if err := s.forward([]byte("AUTH PLAIN " + encodePlain(authzid, authcid, fwd) + "\r\n")); err != nil {
		return nil, false, err
	}
	for {
		ev, err := s.await()
		if err != nil {
			return nil, false, err
		}
		if ev.code == 334 {
			if err := s.forward([]byte("*\r\n")); err != nil {
				return nil, false, err
			}
			continue
		}
		return in, ev.code == 235, nil
	}
}

// deferWithoutMacLiveness answers 454 when a Mac outside its install grace has
// no recent certificate session under its current key. answered is true when it
// wrote a reply, and the sign-in must not be forwarded; err is that write's
// error, or errTooManyTempFails once the Mac has been deferred too often.
func (s *session) deferWithoutMacLiveness(dev *projection.Device, acct *projection.Account) (answered bool, err error) {
	var at netip.Prefix
	if !s.macSMTPAnyAddress {
		// ⚠ FAIL CLOSED: a zero prefix is MacLive's "any address", so a
		// connection with no client address must never reach it.
		if !s.addr.IsValid() {
			s.log.Error("sign-in not forwarded: no client address for the Mac SMTP rule")
			return true, s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n")
		}
		at = projection.MacLivePrefix(s.addr)
	}
	live, err := s.macLive(dev.ID, at, dev.CertKey)
	if err != nil {
		s.log.Error("sign-in not forwarded", slog.Any("err", err))
		return true, s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n")
	}
	if live {
		return false, nil
	}
	s.macTempFails++
	s.log.Info("smtp auth deferred: mac certificate session missing",
		"account", acct.ClerkUserID, "device", dev.ID,
		"sameAddress", !s.macSMTPAnyAddress, "attempts", s.macTempFails)
	if err := s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n"); err != nil {
		return true, err
	}
	if s.macTempFails >= maxMacTempFails {
		return true, errTooManyTempFails
	}
	return true, nil
}

// pumpSMTP reads Stalwart's replies. Before AUTH succeeds it reads whole
// replies, takes the mechanisms the front cannot attribute out of EHLO's AUTH
// line, and reports each reply's code. After, bytes go to the client as they
// come, through smtpServerScan.
//
// ⚠ A 235 THE FRONT DID NOT ASK FOR ENDS THE SESSION. Stalwart refuses a second
// AUTH ("503 5.5.1 Already authenticated", probed on v1.1.0), so this never
// fires today; it is the same guard as IMAP's, for a release that changes that,
// and like IMAP's it is defence in depth only: a second AUTH Stalwart did take
// would reach authd without the front's bind token and be refused.
func (s *session) pumpSMTP() {
	defer close(s.upDone)
	for {
		reply, code, err := readSMTPReply(s.ur)
		if err != nil {
			s.close("upstream_closed")
			return
		}
		signedIn := false
		if code == 235 {
			if !s.authSucceeded(smtpPending, true) {
				return
			}
			signedIn = true
		}
		if code == 250 {
			reply = rewriteEHLO(reply)
		}
		if _, err := s.cw.Write(reply); err != nil {
			s.close("client_write")
			return
		}
		s.emit(event{code: code, cont: code == 334})
		if signedIn {
			var scan smtpServerScan
			r := drainBuffered(s.ur, s.up)
			s.ur = nil // the pre-auth buffer is not kept for the life of the session
			s.pumpRaw(r, scan.scan)
			return
		}
	}
}

// readSMTPReply reads one reply, all its lines, and its code.
func readSMTPReply(r *bufio.Reader) ([]byte, int, error) {
	var out []byte
	for lines := 0; lines < 64; lines++ {
		line, err := readLine(r, maxServerLine)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, line...)
		body := trimEOL(line)
		if len(body) < 3 {
			return nil, 0, errProtocol
		}
		code, err := strconv.Atoi(string(body[:3]))
		if err != nil {
			return nil, 0, errProtocol
		}
		if len(body) == 3 || body[3] == ' ' {
			return out, code, nil
		}
	}
	return nil, 0, errProtocol
}

// rewriteEHLO keeps only PLAIN and LOGIN on the AUTH line, and drops STARTTLS.
//
// The keyword ends at a space, a tab or `=` (the old `AUTH=PLAIN` form). RFC
// 5321 allows only the space, and Stalwart writes one, but a client lenient
// about the others would still read an AUTH line there, so the front reads one
// too.
func rewriteEHLO(reply []byte) []byte {
	lines := strings.SplitAfter(string(reply), "\n")
	var kept []string
	for _, l := range lines {
		if l == "" {
			continue
		}
		body := strings.TrimRight(l, "\r\n")
		if len(body) < 4 {
			kept = append(kept, body)
			continue
		}
		keyword, params := cutEHLOKeyword(body[4:])
		switch {
		case strings.EqualFold(keyword, "STARTTLS"):
			continue
		case strings.EqualFold(keyword, "AUTH"):
			mechs := filterMechanisms(strings.Fields(params), true)
			if len(mechs) == 0 {
				continue
			}
			body = body[:4] + keyword + " " + strings.Join(mechs, " ")
		}
		kept = append(kept, body)
	}
	var b strings.Builder
	for i, l := range kept {
		sep := "-"
		if i == len(kept)-1 {
			sep = " "
		}
		if len(l) >= 4 {
			b.WriteString(l[:3] + sep + l[4:])
		} else {
			b.WriteString(l)
		}
		b.WriteString("\r\n")
	}
	return []byte(b.String())
}

// cutEHLOKeyword splits an EHLO line's text (after the code and separator) into
// its keyword and the parameters after it. Leading blanks are skipped, as a
// lenient client would skip them.
func cutEHLOKeyword(s string) (keyword, params string) {
	s = strings.TrimLeft(s, " \t")
	if i := strings.IndexAny(s, " \t="); i >= 0 {
		return s[:i], s[i+1:]
	}
	return s, ""
}

// smtpServerScan finds a reply line starting with 235 after sign-in. Defence in
// depth; the bind token is the boundary (pumpSMTP).
type smtpServerScan struct {
	col  int
	code [3]byte
}

func (sc *smtpServerScan) scan(p []byte) (int, string) {
	lineStart := 0
	if sc.col != 0 {
		lineStart = -1
	}
	for i, c := range p {
		if c == '\n' {
			sc.col = 0
			lineStart = i + 1
			continue
		}
		if sc.col < 3 {
			sc.code[sc.col] = c
		}
		sc.col++
		if sc.col == 3 && sc.code == [3]byte{'2', '3', '5'} {
			if lineStart < 0 {
				lineStart = 0
			}
			return lineStart, ReasonSecondSignIn
		}
	}
	return -1, ""
}
