package mailfront

import (
	"bufio"
	"bytes"
	"io"
	"strconv"
	"strings"
)

// literalMarker finds a literal announced at the end of a line: `{n}`, `{n+}`,
// `{n-}`, or the literal8 forms `~{...}`. at is where the marker starts.
func literalMarker(body []byte) (n int64, sync bool, at int, ok bool) {
	if len(body) < 3 || body[len(body)-1] != '}' {
		return 0, false, 0, false
	}
	open := bytes.LastIndexByte(body, '{')
	if open < 0 {
		return 0, false, 0, false
	}
	digits := body[open+1 : len(body)-1]
	sync = true
	if l := len(digits); l > 0 && (digits[l-1] == '+' || digits[l-1] == '-') {
		digits, sync = digits[:l-1], false
	}
	if len(digits) == 0 || len(digits) > 19 {
		return 0, false, 0, false
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return 0, false, 0, false
		}
	}
	v, err := strconv.ParseInt(string(digits), 10, 64)
	if err != nil {
		return 0, false, 0, false
	}
	at = open
	if open > 0 && body[open-1] == '~' {
		at = open - 1
	}
	return v, sync, at, true
}

// ── Stalwart's side ──────────────────────────────────────────────────────────

// maxServerLine bounds a line Stalwart sends before sign-in. Stalwart is
// trusted, but a bound costs nothing.
const maxServerLine = 64 << 10

// pumpIMAP reads Stalwart's answers. Before sign-in it parses each one: it
// rewrites the advertised mechanisms, puts the client's tag back on a tagged
// answer, tells the client side about continuations and completions, and
// notices the sign-in. After it, the bytes go to the client as they come,
// through imapServerScan.
//
// ⚠ BEFORE SIGN-IN, EVERY TAGGED ANSWER MUST BE FOR THE ONE COMMAND THE FRONT
// SENT. The front sends Stalwart only commands it built itself, each under a
// random tag of its own (newUpstreamTag), one at a time. A tagged answer for
// any other tag means Stalwart is running a command the front did not send, and
// ends the session. That is what makes a sign-in the front did not see, or one
// racing another under the same tag, impossible to credit to the wrong account.
//
// ⚠ AFTER SIGN-IN, STALWART'S OUTPUT IS STILL WATCHED, AS DEFENCE IN DEPTH ONLY.
// Stalwart answers UNAUTHENTICATE and then a second LOGIN on the same connection
// (probed on v1.1.0 and v1.2.0), so a client could sign in as one account and carry on as
// another. The bind token (internal/bindtoken) is what stops that: the second
// LOGIN reaches authd without a token and is refused. The scan below is not the
// boundary and can be blinded (round 3, imapServerScan). It stays because,
// where it works, it ends the connection instead of leaving it signed in as
// the first account, and because Stalwart's recovery admin, which never
// reaches authd, is outside the token. Every successful sign-in Stalwart
// answers carries a CAPABILITY response code in its tagged OK, so after
// sign-in any tagged OK with one ends the session.
func (s *session) pumpIMAP() {
	defer close(s.upDone)
	for {
		unit, first, err := readIMAPResponse(s.ur)
		if err != nil {
			s.close("upstream_closed")
			return
		}
		r := classifyIMAP(first)
		if r.capability {
			unit = rewriteIMAPCapabilities(unit)
		}
		if r.preauth {
			// A session Stalwart signed in without a sign-in.
			s.close(ReasonUnattribAuth)
			return
		}
		signedIn := false
		if r.tag != "" {
			clientTag, ok := s.answering(r.tag)
			if !ok {
				s.close(ReasonUnexpectedTag)
				return
			}
			if r.status == "OK" {
				if s.authSucceeded(r.tag, r.capCode) {
					signedIn = true
				} else if r.capCode {
					return // a sign-in this session did not ask for: closed
				}
			}
			unit = append([]byte(clientTag), unit[len(r.tag):]...)
		}
		if _, err := s.cw.Write(unit); err != nil {
			s.close("client_write")
			return
		}
		switch {
		case r.cont:
			s.emit(event{cont: true})
		case r.tag != "":
			s.emit(event{tag: r.tag, status: r.status})
		}
		if signedIn {
			var scan imapServerScan
			rd := drainBuffered(s.ur, s.up)
			s.ur = nil // the pre-auth buffer is not kept for the life of the session
			s.pumpRaw(rd, scan.scan)
			return
		}
	}
}

// readIMAPResponse reads one response, its literals included, and returns it with
// its first line.
func readIMAPResponse(r *bufio.Reader) (unit, first []byte, err error) {
	for {
		line, err := readLine(r, maxServerLine)
		if err != nil {
			return nil, nil, err
		}
		if first == nil {
			first = trimEOL(line)
		}
		unit = append(unit, line...)
		n, _, _, ok := literalMarker(trimEOL(line))
		if !ok {
			return unit, first, nil
		}
		if n > maxServerLine || len(unit) > 4*maxServerLine {
			return nil, nil, errProtocol
		}
		lit := make([]byte, n)
		if _, err := io.ReadFull(r, lit); err != nil {
			return nil, nil, err
		}
		unit = append(unit, lit...)
	}
}

type imapResponse struct {
	cont       bool
	tag        string // "" for untagged and continuations
	status     string
	capCode    bool // a [CAPABILITY ...] response code
	capability bool // carries a capability list
	preauth    bool
}

func classifyIMAP(line []byte) imapResponse {
	var r imapResponse
	if len(line) > 0 && line[0] == '+' {
		r.cont = true
		return r
	}
	tag, rest, _ := strings.Cut(string(line), " ")
	status, rest, _ := strings.Cut(rest, " ")
	status = strings.ToUpper(status)
	r.status = status
	if tag != "*" {
		r.tag = tag
	}
	upper := strings.ToUpper(rest)
	r.capCode = strings.HasPrefix(upper, "[CAPABILITY ")
	r.capability = r.capCode || (tag == "*" && status == "CAPABILITY")
	r.preauth = tag == "*" && status == "PREAUTH"
	return r
}

// rewriteIMAPCapabilities drops every AUTH= mechanism the front cannot
// attribute from a capability list (the greeting's code, CAPABILITY's answer,
// or the code on the sign-in's OK), and COMPRESS, which would hide Stalwart's
// output from imapServerScan.
func rewriteIMAPCapabilities(unit []byte) []byte {
	body := trimEOL(unit)
	eol := unit[len(body):]
	words := strings.Split(string(body), " ")
	kept := words[:0]
	for _, w := range words {
		bare := strings.TrimSuffix(strings.TrimPrefix(w, "["), "]")
		up := strings.ToUpper(bare)
		drop := false
		switch {
		case strings.HasPrefix(up, "AUTH="):
			drop = !supportedMech(up[len("AUTH="):], false)
		case strings.HasPrefix(up, "COMPRESS="):
			drop = true
		}
		if drop {
			if strings.HasSuffix(w, "]") && len(kept) > 0 {
				kept[len(kept)-1] += "]"
			}
			continue
		}
		kept = append(kept, w)
	}
	out := []byte(strings.Join(kept, " "))
	return append(out, eol...)
}

// imapServerScan follows Stalwart's output after sign-in, with a few bytes of
// state, and finds a line that signs someone in again: an OK with a
// [CAPABILITY response code.
//
// ⚠ WHATEVER THE FIRST WORD IS, `*` AND `+` INCLUDED. Stalwart takes any
// non-blank bytes as a tag and echoes them on a successful sign-in, so
// `* LOGIN b pw` after sign-in is answered `* OK [CAPABILITY ...]`. Stalwart
// v1.1.0 and v1.2.0 send the [CAPABILITY code in two places only: the greeting,
// which is before sign-in, and a sign-in's success (lib.rs:47,
// op/authenticate.rs:205). So after sign-in every such line is a sign-in.
// v1.2.0's `* BYE Account access changed` on a revoked session carries none.
//
// Literals Stalwart announces are skipped exactly, so nothing inside a message
// can be read as such a line, and the text that continues a response after its
// literal is never read as a new line.
//
// ⚠ DEFENCE IN DEPTH, NOT THE ATTRIBUTION BOUNDARY: THE BIND TOKEN IS. This scan
// trusts that Stalwart never ends a line with bytes a client chose, and that is
// false. Round 3 (2026-11-22) sent `SEARCH BEFORE` with the literal
// `x {99999999}` CRLF; Stalwart's error quotes it raw, so a line ended in
// `{99999999}`, this scan skipped what it took for 100 MB of literal, and an
// UNAUTHENTICATE and a second LOGIN behind it went unseen. authd refuses that
// LOGIN (no token), probed live in docs/research/mail-device-binding.md
// section 9. Do not weaken the token on the strength of this scan.
type imapServerScan struct {
	literal int64 // literal bytes still to pass
	state   int
	word    [11]byte
	wlen    int
	tail    [24]byte // the end of the current line, for a literal marker
	tlen    int
}

const (
	scanTag = iota
	scanStatus
	scanCode
	scanRest
)

const capCode = "[CAPABILITY"

// scan returns the offset in p of the line that must not reach the client and
// a reason, or -1. A line that began in an earlier chunk is cut at 0: part of it
// has reached the client, and the session ends anyway.
func (sc *imapServerScan) scan(p []byte) (int, string) {
	lineStart := -1
	if sc.state == scanTag && sc.tlen == 0 {
		lineStart = 0
	}
	for i := 0; i < len(p); i++ {
		if sc.literal > 0 {
			skip := min(int64(len(p)-i), sc.literal)
			sc.literal -= skip
			i += int(skip) - 1
			continue
		}
		c := p[i]
		if c == '\n' {
			n, _, _, ok := literalMarker(trimCR(sc.tail[:sc.tlen]))
			sc.tlen, sc.wlen = 0, 0
			if ok {
				sc.literal, sc.state = n, scanRest
			} else {
				sc.state, lineStart = scanTag, i+1
			}
			continue
		}
		if sc.tlen == len(sc.tail) {
			copy(sc.tail[:], sc.tail[1:])
			sc.tlen--
		}
		sc.tail[sc.tlen] = c
		sc.tlen++

		switch sc.state {
		case scanTag:
			if c == ' ' {
				sc.state, sc.wlen = scanStatus, 0
			}
		case scanStatus:
			if c == ' ' {
				if sc.wlen == 2 && strings.EqualFold(string(sc.word[:2]), "OK") {
					sc.state = scanCode
				} else {
					sc.state = scanRest
				}
				sc.wlen = 0
				continue
			}
			if sc.wlen < len(sc.word) {
				sc.word[sc.wlen] = c
			}
			sc.wlen++
		case scanCode:
			sc.word[sc.wlen] = c
			sc.wlen++
			if sc.wlen == len(capCode) {
				if strings.EqualFold(string(sc.word[:]), capCode) {
					return max(lineStart, 0), ReasonSecondSignIn
				}
				sc.state = scanRest
			}
		}
	}
	return -1, ""
}

func trimCR(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\r' {
		return b[:n-1]
	}
	return b
}
