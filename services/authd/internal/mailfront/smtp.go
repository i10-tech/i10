package mailfront

import (
	"bufio"
	"log/slog"
	"strconv"
	"strings"
)

const smtpPending = "smtp-auth"

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
func (s *session) smtpAuth(args string) (*signIn, bool, error) {
	mech, ir, hasIR := strings.Cut(args, " ")
	mech = strings.ToUpper(mech)
	if hasIR && (ir == "" || strings.Contains(ir, " ")) {
		return nil, false, s.cw.WriteString("501 5.5.4 Syntax: AUTH mechanism [initial-response]\r\n")
	}
	if !supportedMech(mech, true) {
		return nil, false, s.cw.WriteString("504 5.5.4 Unrecognized authentication type.\r\n")
	}

	var in *signIn
	// step 0 is the response that names the user: PLAIN's only one, LOGIN's
	// first. respond turns a client response into what is forwarded: the
	// password, wherever it is, goes behind the token authd requires. An error
	// is the front having no key to sign it with.
	respond := func(step int, resp string) (string, error) {
		if resp == "*" {
			return "*", nil
		}
		if step > 0 {
			if mech == mechLogin && step == 1 {
				// LOGIN's password. Not logged.
				return passwordWithToken(resp, s.tokenFor(in))
			}
			return canonicalB64(resp), nil
		}
		var res saslResult
		if mech == mechPlain {
			res = parsePlain(resp)
		} else {
			res = parseLoginUser(resp)
		}
		if !res.ok || res.foreignAuthzid {
			return "*", nil
		}
		in = s.signInAs(res.authcid)
		if mech == mechPlain {
			return plainWithToken(resp, s.tokenFor(in))
		}
		return canonicalB64(resp), nil
	}

	s.setPending(smtpPending)
	cmd := "AUTH " + mech
	step := 0
	if hasIR {
		fwd, err := respond(step, strings.TrimSpace(ir))
		if err != nil {
			s.setPending("")
			s.log.Error("sign-in not forwarded", slog.Any("err", err))
			return nil, false, s.cw.WriteString("454 4.7.0 Temporary authentication failure.\r\n")
		}
		if fwd == "*" {
			s.setPending("")
			return nil, false, s.cw.WriteString("535 5.7.8 Authentication credentials invalid.\r\n")
		}
		cmd += " " + fwd
		step++
	}
	if err := s.forward([]byte(cmd + "\r\n")); err != nil {
		return nil, false, err
	}
	for ; ; step++ {
		ev, err := s.await()
		if err != nil {
			return nil, false, err
		}
		if ev.code != 334 {
			return in, ev.code == 235, nil
		}
		if step > 3 {
			// Neither mechanism has this many steps.
			if err := s.forward([]byte("*\r\n")); err != nil {
				return nil, false, err
			}
			continue
		}
		line, err := readLine(s.cr, s.lim.MaxLine)
		if err != nil {
			return nil, false, err
		}
		fwd, err := respond(step, strings.TrimSpace(string(trimEOL(line))))
		if err != nil {
			// No key to sign with: cancel, and Stalwart answers.
			s.log.Error("sign-in not forwarded", slog.Any("err", err))
			fwd = "*"
		}
		if err := s.forward([]byte(fwd + "\r\n")); err != nil {
			return nil, false, err
		}
	}
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
