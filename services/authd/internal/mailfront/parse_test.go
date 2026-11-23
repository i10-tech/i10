package mailfront

import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestServerScanSkipsLiteralsAndFindsSecondSignIns(t *testing.T) {
	cases := []struct {
		name string
		in   string
		cut  bool
	}{
		{"ordinary answers", "* 3 EXISTS\r\na OK done\r\n+ idling\r\n", false},
		{"a tagged OK with a capability code", "* 3 EXISTS\r\nc OK [CAPABILITY IMAP4rev2] signed in\r\n", true},
		{"lower case", "c ok [capability imap4rev2] x\r\n", true},
		{"a long tag", strings.Repeat("t", 300) + " OK [CAPABILITY IMAP4rev2]\r\n", true},
		// After sign-in Stalwart sends this only for a sign-in tagged `*`.
		{"OK with a capability code under the tag *", "* OK [CAPABILITY IMAP4rev2] hi\r\n", true},
		{"OK with a capability code under the tag +", "+ OK [CAPABILITY IMAP4rev2] hi\r\n", true},
		{"NO with a capability code", "c NO [CAPABILITY IMAP4rev2] x\r\n", false},
		{"inside a literal", "* 1 FETCH (BODY[] {32}\r\nc OK [CAPABILITY IMAP4rev2] x\r\n)\r\n", false},
		{"inside a literal8", "* 1 FETCH (BINARY[] ~{32}\r\nc OK [CAPABILITY IMAP4rev2] x\r\n)\r\n", false},
		{"after a literal, on the same response", "* 1 FETCH (BODY[] {2}\r\nhi c OK [CAPABILITY x])\r\n", false},
		{"after a literal, on the next line", "* 1 FETCH (BODY[] {2}\r\nhi)\r\nc OK [CAPABILITY x]\r\n", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var sc imapServerScan
			cut, _ := sc.scan([]byte(tc.in))
			if (cut >= 0) != tc.cut {
				t.Fatalf("cut at %d, want a cut: %v", cut, tc.cut)
			}
			if cut >= 0 && strings.Contains(tc.in[:cut], "[CAPABILITY") {
				t.Fatalf("the cut at %d lets the sign-in line through", cut)
			}
		})
	}
}

func TestSMTPServerScan(t *testing.T) {
	var sc smtpServerScan
	if cut, _ := sc.scan([]byte("250 ok\r\n354 go\r\n")); cut >= 0 {
		t.Fatal("cut an ordinary reply")
	}
	if cut, _ := sc.scan([]byte("250 ok\r\n235 2.7.0 yes\r\n")); cut != len("250 ok\r\n") {
		t.Fatalf("cut at %d", cut)
	}
}

func TestRewriteEHLO(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{
			// The last line went (no mechanism left), so the line before it ends the reply.
			"stalwart's form",
			"250-mail\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN XOAUTH2\r\n250 AUTH OAUTHBEARER\r\n",
			"250-mail\r\n250 AUTH PLAIN LOGIN\r\n",
		},
		{"the old AUTH= form", "250-mail\r\n250 AUTH=PLAIN XOAUTH2\r\n", "250-mail\r\n250 AUTH PLAIN\r\n"},
		{"a tab after AUTH", "250-mail\r\n250 AUTH\tXOAUTH2\r\n", "250 mail\r\n"},
		{"a blank before AUTH", "250-mail\r\n250  AUTH XOAUTH2\r\n", "250 mail\r\n"},
		{"a keyword that only starts with AUTH", "250-mail\r\n250 AUTHX XOAUTH2\r\n", "250-mail\r\n250 AUTHX XOAUTH2\r\n"},
	}
	for _, c := range cases {
		if got := string(rewriteEHLO([]byte(c.in))); got != c.want {
			t.Errorf("%s: rewriteEHLO = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestParsePlain(t *testing.T) {
	cases := []struct {
		in      string
		authcid string
		ok      bool
		foreign bool
	}{
		{plain("", "alice@x", "p"), "alice@x", true, false},
		{plain("Alice@X", "alice@x", "p"), "alice@x", true, false},
		{plain("bob@x", "alice@x", "p"), "alice@x", true, true},
		{plain("", "", "p"), "", false, false},
		{"not base64!", "", false, false},
		{"=", "", false, false},
	}
	for _, tc := range cases {
		got := parsePlain(tc.in)
		if got.authcid != tc.authcid || got.ok != tc.ok || got.foreignAuthzid != tc.foreign {
			t.Errorf("parsePlain(%q) = %+v", tc.in, got)
		}
	}
}

func TestConfigRefusesBindingWhereStalwartListens(t *testing.T) {
	t.Setenv("MAILFRONT_DATABASE_URL", "postgres://x")
	for _, ips := range []string{"0.0.0.0", "::", "127.0.0.1", ""} {
		t.Setenv("MAILFRONT_LISTEN_IPS", ips)
		if _, err := LoadConfig(); err == nil {
			t.Errorf("MAILFRONT_LISTEN_IPS=%q was accepted", ips)
		}
	}
	t.Setenv("MAILFRONT_LISTEN_IPS", "10.42.0.7,fd00::7")
	if _, err := LoadConfig(); err != nil {
		t.Fatalf("pod addresses refused: %v", err)
	}
	t.Setenv("MAILFRONT_IMAP_UPSTREAM", "10.42.0.7:993")
	if _, err := LoadConfig(); err == nil {
		t.Error("a non-loopback upstream was accepted")
	}
}

// The pass-through bound has no "off": it is the only thing that ends a session
// whose person was disabled in their own company's directory.
func TestConfigBoundsThePassthroughMaxAge(t *testing.T) {
	t.Setenv("MAILFRONT_DATABASE_URL", "postgres://x")
	t.Setenv("MAILFRONT_LISTEN_IPS", "10.42.0.7")
	c, err := LoadConfig()
	if err != nil || c.PassthroughMaxAge != DefaultPassthroughMaxAge {
		t.Fatalf("default = %s, %v; want %s", c.PassthroughMaxAge, err, DefaultPassthroughMaxAge)
	}
	for _, v := range []string{"0s", "30s", "25h"} {
		t.Setenv("MAILFRONT_PASSTHROUGH_MAX_AGE", v)
		if _, err := LoadConfig(); err == nil {
			t.Errorf("MAILFRONT_PASSTHROUGH_MAX_AGE=%s was accepted", v)
		}
	}
	t.Setenv("MAILFRONT_PASSTHROUGH_MAX_AGE", "5m")
	if c, err := LoadConfig(); err != nil || c.PassthroughMaxAge != 5*time.Minute {
		t.Fatalf("5m = %s, %v", c.PassthroughMaxAge, err)
	}
}

// ── fuzzing ──────────────────────────────────────────────────────────────────

// FuzzReadIMAPRequest: anything a client sends before signing in is read
// within the limits or refused, never a panic. And whatever the front reads, it
// rebuilds into text that STALWART'S reader (the independent port in
// stalwart_rules_test.go) reads back as exactly the same arguments. That is
// the property the whole pre-auth design rests on.
func FuzzReadIMAPRequest(f *testing.F) {
	for _, s := range []string{
		"a LOGIN alice \"pass\"\r\n", "a LOGIN {5}\r\nalice {4+}\r\npass\r\n", "a AUTHENTICATE PLAIN AGEAYg==\r\n",
		"a ID (\"name\" {3}\r\nabc \"os\" NIL)\r\n", "a LOGIN \"un\\\"ter\" x\r\n", "a NOOP x{5}\r\n", "a\x00b\r\n",
		"a LOGIN \"\" {0}\r\n\r\n", "  \r\na CAPABILITY\r\n", "a ID NIL\r\n",
	} {
		f.Add([]byte(s))
	}
	lim := Limits{MaxLine: 256, MaxLiteral: 64, MaxCommand: 512}
	f.Fuzz(func(t *testing.T, in []byte) {
		cw := &syncWriter{w: io.Discard}
		r := bufio.NewReader(bytes.NewReader(in))
		for i := 0; i < 8; i++ {
			req, err := readIMAPRequest(r, cw, lim)
			if err != nil {
				return
			}
			var b strings.Builder
			b.WriteString("mf1 " + req.verb)
			var want []string
			for _, a := range req.args {
				switch a.kind {
				case argOpen:
					b.WriteString(" (")
					want = append(want, "(")
				case argClose:
					b.WriteString(" )")
					want = append(want, ")")
				default:
					b.WriteString(" " + literal(a.val))
					if a.val == "" {
						want = append(want, stalNil)
					} else {
						want = append(want, a.val)
					}
				}
			}
			b.WriteString("\r\n")
			back, err := stalwartReadIMAP(bufio.NewReader(strings.NewReader(b.String())), func() {})
			if err != nil {
				t.Fatalf("Stalwart cannot read the rebuilt %q: %v", b.String(), err)
			}
			if back.tag != "mf1" || back.command != req.verb || strings.Join(back.args, "\x01") != strings.Join(want, "\x01") {
				t.Fatalf("rebuilt %q reads back as %+v, want %q", b.String(), back, want)
			}
		}
	})
}

// secondSignInAt is the oracle for imapServerScan: the start of the first line
// of Stalwart's output, after sign-in, whose second word is OK and whose third
// starts with [CAPABILITY, whatever the first word is, or -1. Literals are
// skipped, and the text after one continues its response rather than starting
// a line.
func secondSignInAt(in []byte) int {
	pos, startsLine := 0, true
	for pos < len(in) {
		end := bytes.IndexByte(in[pos:], '\n')
		line := in[pos:]
		if end >= 0 {
			line = in[pos : pos+end]
		}
		if startsLine {
			words := strings.SplitN(string(line), " ", 3)
			if len(words) == 3 && strings.EqualFold(words[1], "OK") &&
				len(words[2]) >= len(capCode) && strings.EqualFold(words[2][:len(capCode)], capCode) {
				return pos
			}
		}
		if end < 0 {
			break
		}
		if n, _, _, ok := literalMarker(trimCR(line)); ok {
			pos, startsLine = pos+end+1+int(n), false
			continue
		}
		pos, startsLine = pos+end+1, true
	}
	return -1
}

// FuzzServerScanChunking: the scanner finds exactly the line the oracle finds,
// and where Stalwart's output is split into reads changes neither whether nor
// where.
func FuzzServerScanChunking(f *testing.F) {
	f.Add([]byte("* 1 FETCH (BODY[] {5}\r\nhello)\r\nc OK [CAPABILITY x]\r\n"), uint8(7))
	f.Add([]byte("a OK done\r\n+ idle\r\n"), uint8(1))
	f.Add([]byte("* OK Unauthenticate successful.\r\n* OK [CAPABILITY IMAP4rev2] Authentication successful\r\n"), uint8(5))
	f.Add([]byte("+ OK [CAPABILITY IMAP4rev2] Authentication successful\r\n"), uint8(3))
	f.Fuzz(func(t *testing.T, in []byte, step uint8) {
		var whole imapServerScan
		want, _ := whole.scan(in)
		if oracle := secondSignInAt(in); want != oracle {
			t.Fatalf("scanner found %d, the oracle %d, in %q", want, oracle, in)
		}
		n := int(step%31) + 1
		var chunked imapServerScan
		got := -1
		for off := 0; off < len(in); off += n {
			end := min(off+n, len(in))
			if c, _ := chunked.scan(in[off:end]); c >= 0 {
				got = off + c
				break
			}
		}
		if (want >= 0) != (got >= 0) {
			t.Fatalf("whole found %d, chunks of %d found %d", want, n, got)
		}
		if want >= 0 {
			// A line that began in an earlier read has partly reached the client
			// already, so the cut can come after the line's start. It must come
			// before the code that makes it a sign-in is complete.
			code := bytes.Index(asciiUpper(in[want:]), []byte(" OK "+capCode))
			if code < 0 || got >= want+code+len(" OK "+capCode) {
				t.Fatalf("chunked cut at %d lets the sign-in at %d through", got, want)
			}
		}
	})
}

// FuzzRewriteEHLO: Stalwart's replies, rewritten, stay well-formed.
func FuzzRewriteEHLO(f *testing.F) {
	f.Add([]byte("250-a\r\n250-AUTH PLAIN XOAUTH2\r\n250 8BITMIME\r\n"))
	f.Add([]byte("250-a\r\n250 AUTH\tXOAUTH2 LOGIN\r\n"))
	f.Fuzz(func(t *testing.T, in []byte) {
		// Whatever Stalwart sends, a lenient client sees no STARTTLS and no AUTH
		// mechanism but PLAIN and LOGIN. Lenient: it skips leading blanks, ends
		// the keyword at a space, a tab or `=`, and splits the parameters at any
		// whitespace.
		for _, l := range strings.Split(string(rewriteEHLO(in)), "\r\n") {
			if len(l) < 4 {
				continue
			}
			rest := strings.TrimLeft(l[4:], " \t")
			keyword, params := rest, ""
			if i := strings.IndexAny(rest, " \t="); i >= 0 {
				keyword, params = rest[:i], rest[i+1:]
			}
			words := append([]string{keyword}, strings.Fields(params)...)
			switch {
			case strings.EqualFold(words[0], "STARTTLS"):
				t.Fatalf("STARTTLS kept: %q", l)
			case strings.EqualFold(words[0], "AUTH"):
				for _, m := range words[1:] {
					if !strings.EqualFold(m, "PLAIN") && !strings.EqualFold(m, "LOGIN") {
						t.Fatalf("mechanism %q kept on %q", m, l)
					}
				}
			}
		}
	})
}

func FuzzParsePlain(f *testing.F) {
	f.Add(plain("", "a@b", "c"))
	f.Add("=")
	f.Fuzz(func(t *testing.T, in string) {
		r := parsePlain(in)
		if r.ok && r.authcid == "" {
			t.Fatal("ok with no identity")
		}
	})
}

// asciiUpper upper-cases ASCII letters only, keeping every byte offset.
func asciiUpper(b []byte) []byte {
	out := bytes.Clone(b)
	for i, c := range out {
		if c >= 'a' && c <= 'z' {
			out[i] = c - 32
		}
	}
	return out
}
