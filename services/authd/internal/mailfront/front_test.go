package mailfront

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
)

func alice() *fakeAccounts {
	return newFakeAccounts(account("user_alice", "alice@i10.test"), account("user_bob", "bob@i10.test"))
}

// signInIMAP signs alice in with LOGIN and returns the client.
func signInIMAP(t *testing.T, h *harness) *client {
	t.Helper()
	c := h.dial()
	c.until("* OK")
	c.send(`a1 LOGIN alice@i10.test "right horse"` + "\r\n")
	if got := c.until("a1 "); !strings.HasPrefix(got, "a1 OK") {
		t.Fatalf("LOGIN answered %q", got)
	}
	waitFor(t, "the session to be watched", func() bool { return h.srv.Live() == 1 })
	return c
}

func TestIMAPSignInsThatAreAttributed(t *testing.T) {
	cases := []struct {
		name  string
		lines []string
		// what Stalwart must have been sent for the sign-in
		heard string
	}{
		{"LOGIN with atom and quoted string", []string{`a LOGIN alice@i10.test "right horse"` + "\r\n"}, "LOGIN alice@i10.test right horse"},
		{"LOGIN with quoted strings", []string{`a LOGIN "alice@i10.test" "right horse"` + "\r\n"}, "LOGIN alice@i10.test right horse"},
		{"LOGIN with synchronizing literals", []string{"a LOGIN {14}\r\n", "alice@i10.test {11}\r\n", "right horse\r\n"}, "LOGIN alice@i10.test right horse"},
		{"LOGIN with LITERAL+", []string{"a LOGIN {14+}\r\nalice@i10.test {11+}\r\nright horse\r\n"}, "LOGIN alice@i10.test right horse"},
		{"LOGIN in another case", []string{`a login ALICE@I10.TEST "right horse"` + "\r\n"}, "LOGIN ALICE@I10.TEST right horse"},
		{"a tag with the one IMAP special RFC 3501 allows", []string{`a] LOGIN alice@i10.test "right horse"` + "\r\n"}, "LOGIN alice@i10.test right horse"},
		{"AUTHENTICATE PLAIN with SASL-IR", []string{"a AUTHENTICATE PLAIN " + plain("", "alice@i10.test", rightPassword) + "\r\n"}, "AUTHENTICATE PLAIN " + plain("", "alice@i10.test", rightPassword)},
		{"AUTHENTICATE PLAIN with a continuation", []string{"a AUTHENTICATE PLAIN\r\n", plain("", "alice@i10.test", rightPassword) + "\r\n"}, "sasl:" + plain("", "alice@i10.test", rightPassword)},
		{"PLAIN naming itself as authzid", []string{"a AUTHENTICATE PLAIN " + plain("alice@i10.test", "alice@i10.test", rightPassword) + "\r\n"}, "AUTHENTICATE PLAIN"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := startFront(t, IMAP, alice(), nil)
			c := h.dial()
			c.until("* OK")
			for i, l := range tc.lines {
				c.send(l)
				if i < len(tc.lines)-1 && strings.HasSuffix(l, "}\r\n") || i < len(tc.lines)-1 && strings.HasSuffix(l, "PLAIN\r\n") {
					c.until("+")
				}
			}
			tag, _, _ := strings.Cut(tc.lines[0], " ")
			if got := c.until(tag + " "); !strings.HasPrefix(got, tag+" OK") {
				t.Fatalf("sign-in answered %q", got)
			}
			waitFor(t, "the session to be watched", func() bool { return h.srv.Live() == 1 })
			if got := h.upstream.signedInAs(); len(got) != 1 || !strings.EqualFold(got[0], "alice@i10.test") {
				t.Fatalf("Stalwart signed in %q, want alice once", got)
			}
			if got, raw := h.upstream.tokens(); len(got) != 1 || got[0] != "user_alice" || raw != 0 {
				t.Fatalf("tokens for %q and %d raw sign-ins, want one token, for alice", got, raw)
			}
			found := false
			for _, cmd := range h.upstream.commands() {
				found = found || strings.HasPrefix(cmd, tc.heard)
			}
			if !found {
				t.Fatalf("Stalwart heard %q, want a command starting %q", h.upstream.commands(), tc.heard)
			}
			c.send("b NOOP\r\n")
			c.until("b OK")
		})
	}
}

func TestIMAPAdvertisesOnlyMechanismsItCanAttribute(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	c := h.dial()
	greeting := c.until("* OK")
	c.send("a CAPABILITY\r\n")
	caps := c.until("* CAPABILITY")
	for _, l := range []string{greeting, caps} {
		if strings.Contains(l, "OAUTHBEARER") || strings.Contains(l, "XOAUTH2") || strings.Contains(l, "COMPRESS") {
			t.Fatalf("advertised a mechanism the front cannot attribute: %q", l)
		}
		if !strings.Contains(l, "AUTH=PLAIN") {
			t.Fatalf("PLAIN went missing: %q", l)
		}
	}
	if !strings.HasSuffix(greeting, "] ready") {
		t.Fatalf("the greeting's response code was broken: %q", greeting)
	}
}

func TestIMAPRefusesWhatItCannotAttributeWithoutForwardingIt(t *testing.T) {
	cases := []struct{ name, send, answer string }{
		{"OAUTHBEARER", "a AUTHENTICATE OAUTHBEARER bixhPWFsaWNlQGkxMC50ZXN0LAFhdXRoPUJlYXJlciB4AQE=\r\n", "a BAD"},
		{"XOAUTH2", "a AUTHENTICATE XOAUTH2 dXNlcj1hbGljZQ==\r\n", "a BAD"},
		{"PLAIN acting as somebody else", "a AUTHENTICATE PLAIN " + plain("bob@i10.test", "alice@i10.test", rightPassword) + "\r\n", "a NO"},
		{"PLAIN that is not base64", "a AUTHENTICATE PLAIN !!!\r\n", "a NO"},
		{"LOGIN with one argument", "a LOGIN alice@i10.test\r\n", "a BAD"},
		{"STARTTLS", "a STARTTLS\r\n", "a BAD"},
		{"a command Stalwart would run before sign-in", "a SELECT INBOX\r\n", "a BAD"},
		{"NOOP with arguments", "a NOOP xyz\r\n", "a BAD"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := startFront(t, IMAP, alice(), nil)
			c := h.dial()
			c.until("* OK")
			c.send(tc.send)
			if got := c.line(); !strings.HasPrefix(got, tc.answer) {
				t.Fatalf("answered %q, want %q", got, tc.answer)
			}
			if heard := h.upstream.commands(); len(heard) != 0 {
				t.Fatalf("forwarded %q to Stalwart", heard)
			}
			// The connection is still usable for a real sign-in.
			c.send(`b LOGIN alice@i10.test "right horse"` + "\r\n")
			c.until("b OK")
		})
	}
}

func TestIMAPCancelsAContinuationActingAsSomebodyElse(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	c := h.dial()
	c.until("* OK")
	c.send("a AUTHENTICATE PLAIN\r\n")
	c.until("+")
	c.send(plain("bob@i10.test", "alice@i10.test", rightPassword) + "\r\n")
	if got := c.until("a "); !strings.HasPrefix(got, "a NO") {
		t.Fatalf("answered %q", got)
	}
	if h.srv.Live() != 0 {
		t.Fatal("a cancelled exchange signed in")
	}
	for _, cmd := range h.upstream.commands() {
		if strings.HasPrefix(cmd, "sasl:") && cmd != "sasl:*" {
			t.Fatalf("forwarded the response instead of cancelling it: %q", cmd)
		}
	}
}

func TestASignInTheProjectionDoesNotKnowIsClosed(t *testing.T) {
	// Stalwart's recovery admin is the one sign-in Stalwart takes without authd,
	// and so without a token. The front cannot stand behind it: the session ends.
	t.Run("a sign-in Stalwart takes without authd", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), nil)
		c := h.dial()
		c.until("* OK")
		c.send(`a LOGIN admin "right horse"` + "\r\n")
		if !c.closed(2 * time.Second) {
			t.Fatal("an unattributed session stayed open")
		}
		if h.srv.Live() != 0 {
			t.Fatal("an unattributed session is being watched")
		}
	})
	// A login the projection does not know gets no token, so authd refuses it.
	t.Run("no such account", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), nil)
		c := h.dial()
		c.until("* OK")
		c.send(`a LOGIN carol@i10.test "right horse"` + "\r\n")
		if got := c.until("a "); !strings.HasPrefix(got, "a NO") {
			t.Fatalf("answered %q", got)
		}
		if got, raw := h.upstream.tokens(); len(got) != 0 || raw != 1 {
			t.Fatalf("tokens %q and %d raw sign-ins, want one raw", got, raw)
		}
	})
	// A row that is gone or refused when the front looks: the front sends a token
	// for it, and the sweep or authd's own gate ends it.
	t.Run("suspended before sign-in", func(t *testing.T) {
		accts := newFakeAccounts(account("user_carol", "carol@i10.test"))
		accts.update("carol@i10.test", func(a *projection.Account) { a.Suspended = true })
		h := startFront(t, IMAP, accts, nil)
		c := h.dial()
		c.until("* OK")
		c.send(`a LOGIN carol@i10.test "right horse"` + "\r\n")
		if !c.closed(2 * time.Second) {
			t.Fatal("a refused account's session stayed open")
		}
		if h.srv.Live() != 0 {
			t.Fatal("a refused account's session is being watched")
		}
	})
}

// ⚠ When the projection cannot be read there is no account to mint a token for.
// The front answers "temporarily unavailable" itself (never "wrong password",
// which makes clients ask the person) and forwards nothing.
func TestALookupThatFailsIsAnsweredUnavailableAndForwardsNothing(t *testing.T) {
	accts := alice()
	accts.failAll = true
	h := startFront(t, IMAP, accts, nil)
	c := h.dial()
	c.until("* OK")
	c.send(`a LOGIN alice@i10.test "right horse"` + "\r\n")
	if got := c.until("a "); got != "a NO [UNAVAILABLE] Sign-in is temporarily unavailable." {
		t.Fatalf("answered %q", got)
	}
	for _, cmd := range h.upstream.commands() {
		if strings.HasPrefix(cmd, "LOGIN") {
			t.Fatalf("forwarded %q", cmd)
		}
	}
}

// ⚠ THE ATTRIBUTION BOUNDARY: after sign-in the client's bytes go to Stalwart
// unread, so a LOGIN there reaches authd with the client's raw password, and
// authd refuses every person bind without the front's token. Stalwart never
// signs bob in on a connection the front credits to alice, whatever the tag.
func TestASecondLoginAfterSignInIsRefusedByAuthd(t *testing.T) {
	for name, sequence := range map[string]string{
		"tag *":               "* UNAUTHENTICATE\r\n* LOGIN bob@i10.test \"right horse\"\r\n",
		"tag +":               "+ UNAUTHENTICATE\r\n+ LOGIN bob@i10.test \"right horse\"\r\n",
		"tagged":              "c UNAUTHENTICATE\r\nd LOGIN bob@i10.test \"right horse\"\r\n",
		"PLAIN":               "c UNAUTHENTICATE\r\nd AUTHENTICATE PLAIN " + plain("", "bob@i10.test", rightPassword) + "\r\n",
		"alice herself again": "c UNAUTHENTICATE\r\nd LOGIN alice@i10.test \"right horse\"\r\n",
	} {
		t.Run(name, func(t *testing.T) {
			h := startFront(t, IMAP, alice(), nil)
			c := signInIMAP(t, h)
			c.send(sequence)
			waitFor(t, "authd to see the second sign-in", func() bool { _, raw := h.upstream.tokens(); return raw == 1 })
			if got := h.upstream.signedInAs(); len(got) != 1 || got[0] != "alice@i10.test" {
				t.Fatalf("Stalwart signed in %q, want alice once", got)
			}
			if got, raw := h.upstream.tokens(); len(got) != 1 || got[0] != "user_alice" || raw != 1 {
				t.Fatalf("tokens for %q and %d raw sign-ins, want alice's one token and one raw", got, raw)
			}
		})
	}
}

// The output scanner stays as defence in depth: a sign-in Stalwart answered
// after the first, whatever let it through, still ends the session.
func TestASecondSignInOnTheSameConnectionClosesIt(t *testing.T) {
	// Stalwart takes any non-blank bytes as a tag and echoes them on a
	// successful sign-in, `*` and `+` included (found by review, 2026-11-22).
	for name, sequence := range map[string]string{
		"tagged":               "b XSIGNIN\r\n",
		"tag *":                "* XSIGNIN\r\n",
		"tag +":                "+ XSIGNIN\r\n",
		"Stalwart's own admin": "c UNAUTHENTICATE\r\nd LOGIN admin \"right horse\"\r\n",
	} {
		t.Run(name, func(t *testing.T) {
			h := startFront(t, IMAP, alice(), nil)
			c := signInIMAP(t, h)
			c.send(sequence)
			if !c.closed(2 * time.Second) {
				t.Fatal("a second sign-in on one connection was let through")
			}
			if strings.Contains(c.seen(), "Authentication successful") {
				t.Fatalf("the client saw the second sign-in succeed:\n%s", c.seen())
			}
		})
	}
}

// The attack the review found (2026-11-21): Stalwart opens a literal only after
// whitespace, so to Stalwart `x{N}` is a word and the N bytes after the line
// are a second command. A front that read `x{N}` as a literal answered "+",
// forwarded the bytes, and Stalwart ran a LOGIN the front never saw, which a
// pipelined LOGIN under the same tag then got credited for.
func TestTheHiddenLoginIsRefused(t *testing.T) {
	hidden := "T LOGIN bob@i10.test \"right horse\"\r\n"
	h := startFront(t, IMAP, alice(), nil)
	c := h.dial()
	c.until("* OK")
	// ⚠ ONE WRITE, AS AN ATTACKER SENDS IT. The front ends the connection on the
	// first line (an ambiguous literal), so a second write can land on a closed
	// socket and fail with a broken pipe: that was a race in this test, not in
	// the front.
	c.send("a NOOP x{" + strconv.Itoa(len(hidden)) + "}\r\n" +
		hidden +
		`T LOGIN alice@i10.test "right horse"` + "\r\n")
	if !c.closed(2 * time.Second) {
		t.Fatal("still open after an ambiguous literal")
	}
	if got := c.seen(); got != "" && !strings.HasPrefix(got, "a BAD") && !strings.HasPrefix(got, "* BYE") {
		t.Fatalf("answered %q", got)
	}
	// Whatever the front does next, Stalwart must never sign bob in on a
	// session the front credits to alice.
	time.Sleep(200 * time.Millisecond)
	if got := h.upstream.signedInAs(); len(got) > 1 || (len(got) == 1 && h.srv.Live() == 1 && got[0] != "alice@i10.test") {
		t.Fatalf("Stalwart signed in %q", got)
	}
	for _, cmd := range h.upstream.commands() {
		if strings.Contains(cmd, "bob@") {
			t.Fatalf("the hidden LOGIN reached Stalwart: %q", h.upstream.commands())
		}
	}
}

func TestAmbiguousCommandsEndTheConnectionAndReachNothing(t *testing.T) {
	for _, in := range []string{
		"a NOOP x{5}\r\n",                 // a brace in a word: a word to Stalwart
		"a LOGIN x\"y\" z\r\n",            // a quote in a word
		"a\tb LOGIN alice@i10.test x\r\n", // Stalwart drops a tab in a tag
		"a LOGIN\talice@i10.test x\r\n",   // any whitespace separates to Stalwart
		"a LOGIN alice@i10.test x\ry\r\n", // a CR inside a line
		"a LOGIN \"a\\b\" x\r\n",          // an escape Stalwart keeps the backslash of
		"a LOGIN ~{3}\r\n",                // literal8
		"a LOGIN {3}  \r\n",               // whitespace after a literal's brace
		"a LO-GIN x y\r\n",                // a byte a verb cannot hold
		"* LOGIN alice@i10.test x\r\n",    // a tag Stalwart takes and RFC 3501 does not
		"+ LOGIN alice@i10.test x\r\n",
		"a(b LOGIN alice@i10.test x\r\n",
	} {
		t.Run(strconv.Quote(in), func(t *testing.T) {
			h := startFront(t, IMAP, alice(), nil)
			c := h.dial()
			c.until("* OK")
			c.send(in)
			if !c.closed(2 * time.Second) {
				t.Fatal("still open")
			}
			if heard := h.upstream.commands(); len(heard) != 0 {
				t.Fatalf("forwarded %q", heard)
			}
		})
	}
}

func TestAnUnexpectedTaggedOKWhileASignInIsPendingCloses(t *testing.T) {
	accts := newFakeAccounts(account("user_racer", "racer@i10.test"))
	h := startFront(t, IMAP, accts, nil)
	c := h.dial()
	c.until("* OK")
	c.send(`a LOGIN racer@i10.test "right horse"` + "\r\n")
	if got := c.line(); got != "" {
		t.Fatalf("the client was answered %q", got)
	}
	if h.srv.Live() != 0 {
		t.Fatal("a session was credited")
	}
}

func TestATaggedAnswerForACommandTheFrontDidNotSendCloses(t *testing.T) {
	accts := newFakeAccounts(account("user_stray", "stray@i10.test"))
	h := startFront(t, IMAP, accts, nil)
	c := h.dial()
	c.until("* OK")
	c.send(`a LOGIN stray@i10.test "right horse"` + "\r\n")
	if got := c.line(); got != "" {
		t.Fatalf("the client was answered %q", got)
	}
}

func TestStalwartReadsABraceInAWordAsAWord(t *testing.T) {
	// The fake's reader is Stalwart's, so it must show the hidden command.
	r := bufio.NewReader(strings.NewReader("a NOOP x{5+}\r\nT LOGIN v p\r\n"))
	first, err := stalwartReadIMAP(r, func() {})
	if err != nil || first.command != "NOOP" || len(first.args) != 1 || first.args[0] != "x{5+}" {
		t.Fatalf("first = %+v, %v", first, err)
	}
	second, err := stalwartReadIMAP(r, func() {})
	if err != nil || second.command != "LOGIN" || second.tag != "T" {
		t.Fatalf("second = %+v, %v", second, err)
	}
}

func TestMessageTextThatLooksLikeASignInDoesNotCloseTheSession(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	c := signInIMAP(t, h)
	c.send("b XFETCH\r\n")
	c.until("b OK FETCH done")
	c.send("c IDLE\r\n")
	c.until("+ idling")
	c.send("DONE\r\n")
	c.until("c OK")
}

func TestRevocationClosesOpenSessions(t *testing.T) {
	cases := []struct {
		name   string
		change func(*projection.Account)
	}{
		{"suspended", func(a *projection.Account) { a.Suspended = true }},
		{"deleting", func(a *projection.Account) { a.Deleting = true }},
		{"payment hold", func(a *projection.Account) { a.PaymentHold = true }},
		{"domain no longer hosted", func(a *projection.Account) { a.DomainNotHosted = true }},
		{"banned", func(a *projection.Account) { a.Banned = true }},
		{"locked", func(a *projection.Account) { a.Locked = true }},
		{"SSO required", func(a *projection.Account) { a.SSORequired = true }},
		{"credential epoch raised", func(a *projection.Account) { a.CredentialEpoch++ }},
		{"changed in Clerk", func(a *projection.Account) { t := a.ClerkUpdatedAt.Add(time.Second); a.ClerkUpdatedAt = &t }},
		{"now managed by a connection", func(a *projection.Account) { a.Managed, a.ManagedConnection = true, "conn-1" }},
		{"gone", func(a *projection.Account) { a.Active = false }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := startFront(t, IMAP, alice(), nil)
			c := signInIMAP(t, h)
			c.send("b IDLE\r\n")
			c.until("+ idling")

			if st := h.sweeper.Sweep(context.Background()); st.Closed != 0 {
				t.Fatalf("a sweep with nothing changed closed %d", st.Closed)
			}
			h.accounts.update("alice@i10.test", tc.change)
			if st := h.sweeper.Sweep(context.Background()); st.Closed != 1 {
				t.Fatalf("sweep closed %d connections, want 1", st.Closed)
			}
			if !c.closed(time.Second) {
				t.Fatal("the IDLE session is still open")
			}
		})
	}
}

func TestSSOExemptionKeepsTheSessionAndLosingItCloses(t *testing.T) {
	accts := alice()
	accts.update("alice@i10.test", func(a *projection.Account) { a.SSORequired, a.SSOExempt = true, true })
	h := startFront(t, IMAP, accts, nil)
	c := signInIMAP(t, h)
	if st := h.sweeper.Sweep(context.Background()); st.Closed != 0 {
		t.Fatal("an exempt person was closed")
	}
	accts.update("alice@i10.test", func(a *projection.Account) { a.SSOExempt = false })
	if st := h.sweeper.Sweep(context.Background()); st.Closed != 1 {
		t.Fatalf("closed %d, want 1", st.Closed)
	}
	if !c.closed(time.Second) {
		t.Fatal("still open")
	}
}

func TestTheSweepClosesOnlyTheRevokedAccount(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	a := signInIMAP(t, h)
	b := h.dial()
	b.until("* OK")
	b.send(`x LOGIN bob@i10.test "right horse"` + "\r\n")
	b.until("x OK")
	waitFor(t, "two sessions", func() bool { return h.srv.Live() == 2 })

	h.accounts.update("bob@i10.test", func(a *projection.Account) { a.Suspended = true })
	st := h.sweeper.Sweep(context.Background())
	if st.Accounts != 2 || st.Closed != 1 {
		t.Fatalf("sweep %+v, want 2 accounts and 1 closed", st)
	}
	if !b.closed(time.Second) {
		t.Fatal("bob's session is still open")
	}
	a.send("n NOOP\r\n")
	a.until("n OK")
}

// ⚠ A revocation in a company's own directory never reaches the row, so a
// pass-through session is closed at its maximum age and the client asks the
// directory again. A Clerk-routed one is not: Clerk's changes reach the row.
func TestAPassthroughSessionEndsAtItsMaxAgeAndAClerkOneDoesNot(t *testing.T) {
	managed := account("user_alice", "alice@i10.test")
	managed.Managed, managed.ManagedConnection = true, "conn-1"
	logs := &lockedBuffer{}
	const maxAge = 300 * time.Millisecond
	h := startFront(t, IMAP, newFakeAccounts(managed, account("user_bob", "bob@i10.test")), func(s *Server) {
		s.PassthroughMaxAge = maxAge
		s.Log = slog.New(slog.NewTextHandler(logs, nil))
	})
	a := signInIMAP(t, h)
	b := h.dial()
	b.until("* OK")
	b.send(`x LOGIN bob@i10.test "right horse"` + "\r\n")
	b.until("x OK")
	waitFor(t, "two sessions", func() bool { return h.srv.Live() == 2 })

	if st := h.sweeper.Sweep(context.Background()); st.Closed != 0 {
		t.Fatalf("closed %d before the max age", st.Closed)
	}
	time.Sleep(maxAge)
	if st := h.sweeper.Sweep(context.Background()); st.Closed != 1 {
		t.Fatalf("closed %d at the max age, want only the pass-through session", st.Closed)
	}
	if !a.closed(time.Second) {
		t.Fatal("the pass-through session outlived its max age")
	}
	b.send("n NOOP\r\n")
	b.until("n OK")
	waitFor(t, "the close reason in the log", func() bool { return strings.Contains(logs.String(), ReasonMaxAge) })
}

// Each session ends up to a tenth before its max age, never after it, so a
// crowd that signed in together comes back spread out.
func TestPassthroughSessionsEndSpreadOutButNeverLate(t *testing.T) {
	s := &Server{PassthroughMaxAge: 15 * time.Minute}
	at := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	earliest, latest := at.Add(time.Hour), at
	for i := 0; i < 2000; i++ {
		u := s.passthroughUntil(at)
		if u.Before(at.Add(13*time.Minute+30*time.Second)) || u.After(at.Add(15*time.Minute)) {
			t.Fatalf("until %s, want within the last tenth of 15m", u.Sub(at))
		}
		if u.Before(earliest) {
			earliest = u
		}
		if u.After(latest) {
			latest = u
		}
	}
	if latest.Sub(earliest) < time.Minute {
		t.Fatalf("2000 sessions end within %s of each other: not spread", latest.Sub(earliest))
	}
}

func TestAnUnreachableProjectionClosesNothing(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	c := signInIMAP(t, h)
	h.accounts.update("alice@i10.test", func(a *projection.Account) { a.Suspended = true })
	h.accounts.mu.Lock()
	h.accounts.failAll = true
	h.accounts.mu.Unlock()
	if st := h.sweeper.Sweep(context.Background()); st.Err == nil || st.Closed != 0 {
		t.Fatalf("sweep %+v, want an error and nothing closed", st)
	}
	c.send("n NOOP\r\n")
	c.until("n OK")

	// The first sweep that can read the rows closes it.
	h.accounts.mu.Lock()
	h.accounts.failAll = false
	h.accounts.mu.Unlock()
	if st := h.sweeper.Sweep(context.Background()); st.Closed != 1 {
		t.Fatalf("closed %d after recovery, want 1", st.Closed)
	}
}

// ⚠ THE MAXIMUM AGE IS THE CLOCK'S, NOT THE DATABASE'S: an outage of ours must
// not lift the one bound on a revocation in a company's own directory.
func TestAnExpiredPassthroughSessionClosesWhileTheProjectionIsDown(t *testing.T) {
	managed := account("user_alice", "alice@i10.test")
	managed.Managed, managed.ManagedConnection = true, "conn-1"
	const maxAge = 200 * time.Millisecond
	h := startFront(t, IMAP, newFakeAccounts(managed, account("user_bob", "bob@i10.test")), func(s *Server) {
		s.PassthroughMaxAge = maxAge
	})
	a := signInIMAP(t, h)
	b := h.dial()
	b.until("* OK")
	b.send(`x LOGIN bob@i10.test "right horse"` + "\r\n")
	b.until("x OK")
	waitFor(t, "two sessions", func() bool { return h.srv.Live() == 2 })

	h.accounts.mu.Lock()
	h.accounts.failAll = true
	h.accounts.mu.Unlock()
	time.Sleep(maxAge)
	st := h.sweeper.Sweep(context.Background())
	if st.Err == nil || st.Closed != 1 {
		t.Fatalf("sweep %+v, want the query's error and the expired session closed", st)
	}
	if !a.closed(time.Second) {
		t.Fatal("the expired pass-through session outlived its max age because the database was down")
	}
	// Bob's Clerk session has no max age, and nothing else is closed on an outage.
	b.send("n NOOP\r\n")
	b.until("n OK")
}

// An expired session is not asked about: with nothing else live, no query runs.
func TestOnlyExpiredSessionsNeedNoQuery(t *testing.T) {
	managed := account("user_alice", "alice@i10.test")
	managed.Managed, managed.ManagedConnection = true, "conn-1"
	h := startFront(t, IMAP, newFakeAccounts(managed), func(s *Server) { s.PassthroughMaxAge = time.Millisecond })
	a := signInIMAP(t, h)
	time.Sleep(5 * time.Millisecond)
	if st := h.sweeper.Sweep(context.Background()); st.Closed != 1 || st.Err != nil {
		t.Fatalf("sweep %+v", st)
	}
	if h.accounts.sweeps != 0 {
		t.Fatalf("%d queries for nothing but an expired session", h.accounts.sweeps)
	}
	if !a.closed(time.Second) {
		t.Fatal("still open")
	}
}

func TestNoLiveConnectionsNoQuery(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	h.sweeper.Sweep(context.Background())
	if h.accounts.sweeps != 0 {
		t.Fatalf("queried %d times with nothing to watch", h.accounts.sweeps)
	}
}

func TestTheProxyHeaderCarriesTheClient(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	c := h.dial()
	c.until("* OK")
	hdr := h.upstream.header(0)
	if hdr == nil || hdr[12] != 0x21 || hdr[13] != proxyTCP4 {
		t.Fatalf("header %x", hdr)
	}
	client := c.c.LocalAddr().(*net.TCPAddr)
	front, _ := net.ResolveTCPAddr("tcp", h.addr)
	if src := net.IP(hdr[16:20]); !src.Equal(client.IP) || int(binary.BigEndian.Uint16(hdr[24:26])) != client.Port {
		t.Fatalf("source %s:%d, want the client %s", src, binary.BigEndian.Uint16(hdr[24:26]), client)
	}
	if dst := binary.BigEndian.Uint16(hdr[26:28]); int(dst) != front.Port {
		t.Fatalf("destination port %d, want the front's own %d (Stalwart reads it as local_port)", dst, front.Port)
	}
}

// ⚠ NO SSL TLV ON IMAP: to Stalwart the connection is then cleartext, and it
// refuses OAUTHBEARER and XOAUTH2, which authd never sees. SMTP keeps it, or
// Stalwart offers no AUTH at all.
func TestOnlySMTPGoesUpstreamAsTLS(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	h.dial().until("* OK")
	if hdr := h.upstream.header(0); len(hdr) != 16+12 || binary.BigEndian.Uint16(hdr[14:16]) != 12 {
		t.Fatalf("IMAP header %x, want the address block and nothing after it", hdr)
	}

	h = startFront(t, SMTP, alice(), nil)
	h.dial().until("220")
	tlv := h.upstream.header(0)[28:]
	if len(tlv) < 8 || tlv[0] != pp2TypeSSL || tlv[3]&pp2ClientSSL == 0 || !strings.Contains(string(tlv), "TLSv1.3") {
		t.Fatalf("SMTP SSL TLV %x", tlv)
	}
}

func TestPreAuthIsBounded(t *testing.T) {
	t.Run("a line too long", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), nil)
		c := h.dial()
		c.until("* OK")
		c.send("a LOGIN " + strings.Repeat("x", DefaultLimits.MaxLine) + "\r\n")
		if !c.closed(2 * time.Second) {
			t.Fatal("still open")
		}
	})
	t.Run("a literal too large", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), nil)
		c := h.dial()
		c.until("* OK")
		c.send("a LOGIN {100000000}\r\n")
		if !c.closed(2 * time.Second) {
			t.Fatal("still open")
		}
	})
	t.Run("too slow to sign in", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), func(s *Server) { s.Limits.PreAuth = 300 * time.Millisecond })
		c := h.dial()
		c.until("* OK")
		if !c.closed(2 * time.Second) {
			t.Fatal("still open")
		}
	})
	t.Run("too many commands", func(t *testing.T) {
		h := startFront(t, IMAP, alice(), func(s *Server) { s.Limits.MaxCommands = 3 })
		c := h.dial()
		c.until("* OK")
		for i := 0; i < 3; i++ {
			c.send("n NOOP\r\n")
			c.until("n OK")
		}
		c.send("n NOOP\r\n")
		if !c.closed(2 * time.Second) {
			t.Fatal("still open")
		}
	})
	t.Run("connections from one address", func(t *testing.T) {
		logs := &lockedBuffer{}
		h := startFront(t, IMAP, alice(), func(s *Server) {
			s.MaxPreAuthPerIP = 2
			s.Log = slog.New(slog.NewTextHandler(logs, nil))
			s.refusedWindow = 200 * time.Millisecond
		})
		for i := 0; i < 2; i++ {
			h.dial().until("* OK")
		}
		refusedAtAccept := func() {
			t.Helper()
			raw, err := net.Dial("tcp", h.addr)
			if err != nil {
				t.Fatal(err)
			}
			defer raw.Close()
			_ = raw.SetReadDeadline(time.Now().Add(2 * time.Second))
			if _, err := raw.Read(make([]byte, 1)); err == nil {
				t.Fatal("a pre-auth connection past the cap from one address was served")
			}
		}
		refusedAtAccept()
		refusedAtAccept()
		// Both refusals fall in one window: one line, counting both.
		deadline := time.Now().Add(2 * time.Second)
		for !strings.Contains(logs.String(), "refused connections at accept") && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(400 * time.Millisecond)
		got := logs.String()
		if n := strings.Count(got, "refused connections at accept"); n != 1 {
			t.Fatalf("want one report of refusals at accept, got %d:\n%s", n, got)
		}
		if !strings.Contains(got, "max_preauth_per_ip:2") {
			t.Fatalf("the report does not name the cap and its count:\n%s", got)
		}
	})
}

// lockedBuffer is a log sink the front's goroutines and the test can share.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestShutdownClosesEveryConnection(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	signedIn := signInIMAP(t, h)
	waiting := h.dial()
	waiting.until("* OK")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	h.srv.Shutdown(ctx)
	if !signedIn.closed(time.Second) || !waiting.closed(time.Second) {
		t.Fatal("a connection survived shutdown")
	}
}

// bootstrap.sh --verify reads this answer to tell the front from Stalwart, which
// words it "Already in TLS mode.": it must come from the front, on both ports.
func TestStartTLSIsAnsweredByTheFrontWithItsMarker(t *testing.T) {
	h := startFront(t, IMAP, alice(), nil)
	c := h.dial()
	c.until("* OK")
	c.send("a STARTTLS\r\n")
	if got := c.until("a "); got != "a BAD "+startTLSAnswer {
		t.Fatalf("IMAP STARTTLS answered %q", got)
	}
	s := startFront(t, SMTP, alice(), nil)
	m := s.dial()
	m.until("220")
	m.send("EHLO verify.i10.tech\r\n")
	m.until("250 ")
	m.send("STARTTLS\r\n")
	if got := m.line(); got != "503 5.5.1 "+startTLSAnswer {
		t.Fatalf("SMTP STARTTLS answered %q", got)
	}
	for _, heard := range append(h.upstream.commands(), s.upstream.commands()...) {
		if strings.Contains(strings.ToUpper(heard), "STARTTLS") {
			t.Fatalf("STARTTLS reached Stalwart: %q", heard)
		}
	}
}

// A front with no key forwards no sign-in: authd would refuse it, and "wrong
// password" would make clients ask the person.
func TestWithNoKeyEverySignInIsAnsweredUnavailable(t *testing.T) {
	h := startFront(t, IMAP, alice(), func(s *Server) { s.BindTokenKey = nil })
	c := h.dial()
	c.until("* OK")
	c.send(`a LOGIN alice@i10.test "right horse"` + "\r\n")
	if got := c.until("a "); got != "a NO [UNAVAILABLE] Sign-in is temporarily unavailable." {
		t.Fatalf("IMAP answered %q", got)
	}
	c.send("b AUTHENTICATE PLAIN " + plain("", "alice@i10.test", rightPassword) + "\r\n")
	if got := c.until("b "); !strings.HasPrefix(got, "b NO [UNAVAILABLE]") {
		t.Fatalf("AUTHENTICATE answered %q", got)
	}
	s := startFront(t, SMTP, alice(), func(s *Server) { s.BindTokenKey = nil })
	m := s.dial()
	m.until("220")
	m.send("AUTH PLAIN " + plain("", "alice@i10.test", rightPassword) + "\r\n")
	if got := m.line(); !strings.HasPrefix(got, "454 ") {
		t.Fatalf("SMTP answered %q", got)
	}
	for _, heard := range append(h.upstream.commands(), s.upstream.commands()...) {
		if strings.HasPrefix(heard, "LOGIN") || strings.HasPrefix(heard, "AUTH") {
			t.Fatalf("forwarded %q with no key", heard)
		}
	}
}

// ── SMTP ─────────────────────────────────────────────────────────────────────

func TestSMTPSignIns(t *testing.T) {
	cases := []struct {
		name  string
		steps []string // client lines; a line after the first waits for a 334
	}{
		{"PLAIN inline", []string{"AUTH PLAIN " + plain("", "alice@i10.test", rightPassword)}},
		{"PLAIN with a continuation", []string{"AUTH PLAIN", plain("", "alice@i10.test", rightPassword)}},
		{"LOGIN", []string{"AUTH LOGIN", b64("alice@i10.test"), b64(rightPassword)}},
		{"LOGIN with the user inline", []string{"AUTH LOGIN " + b64("alice@i10.test"), b64(rightPassword)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := startFront(t, SMTP, alice(), nil)
			c := h.dial()
			c.until("220")
			c.send("EHLO me\r\n")
			ehlo := c.until("250 ")
			_ = ehlo
			for i, s := range tc.steps {
				if i > 0 {
					c.until("334")
				}
				c.send(s + "\r\n")
			}
			if got := c.until(""); !strings.HasPrefix(got, "235") {
				t.Fatalf("AUTH answered %q", got)
			}
			waitFor(t, "the session to be watched", func() bool { return h.srv.Live() == 1 })
			if got, raw := h.upstream.tokens(); len(got) != 1 || got[0] != "user_alice" || raw != 0 {
				t.Fatalf("tokens for %q and %d raw sign-ins, want one token, for alice", got, raw)
			}
			c.send("MAIL FROM:<alice@i10.test>\r\n")
			c.until("250")

			h.accounts.update("alice@i10.test", func(a *projection.Account) { a.PaymentHold = true })
			if st := h.sweeper.Sweep(context.Background()); st.Closed != 1 {
				t.Fatalf("closed %d", st.Closed)
			}
			if !c.closed(time.Second) {
				t.Fatal("SMTP session still open after revocation")
			}
		})
	}
}

func TestSMTPAdvertisesOnlyPlainAndLogin(t *testing.T) {
	h := startFront(t, SMTP, alice(), nil)
	c := h.dial()
	c.until("220")
	c.send("EHLO me\r\n")
	var lines []string
	for {
		l := c.line()
		lines = append(lines, l)
		if strings.HasPrefix(l, "250 ") || l == "" {
			break
		}
	}
	got := strings.Join(lines, "\n")
	if !strings.Contains(got, "250-AUTH PLAIN LOGIN\n") || strings.Contains(got, "OAUTH") {
		t.Fatalf("EHLO answered\n%s", got)
	}
	if lines[len(lines)-1] != "250 8BITMIME" {
		t.Fatalf("the reply's last line changed: %q", lines[len(lines)-1])
	}
}

func TestSMTPRefusals(t *testing.T) {
	cases := []struct{ name, send, answer string }{
		{"XOAUTH2", "AUTH XOAUTH2 dXNlcj1h", "504"},
		{"acting as somebody else", "AUTH PLAIN " + plain("bob@i10.test", "alice@i10.test", rightPassword), "535"},
		{"DATA before AUTH", "DATA", "503"},
		{"STARTTLS", "STARTTLS", "503"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := startFront(t, SMTP, alice(), nil)
			c := h.dial()
			c.until("220")
			c.send(tc.send + "\r\n")
			if got := c.line(); !strings.HasPrefix(got, tc.answer) {
				t.Fatalf("answered %q, want %s", got, tc.answer)
			}
			if heard := h.upstream.commands(); len(heard) != 0 {
				t.Fatalf("forwarded %q", heard)
			}
		})
	}
}

func TestSMTPASecondSignInCloses(t *testing.T) {
	h := startFront(t, SMTP, alice(), nil)
	c := h.dial()
	c.until("220")
	c.send("AUTH PLAIN " + plain("", "alice@i10.test", rightPassword) + "\r\n")
	c.until("235")
	waitFor(t, "the session to be watched", func() bool { return h.srv.Live() == 1 })
	c.send("XSIGNIN\r\n")
	if !c.closed(2 * time.Second) {
		t.Fatal("a 235 after sign-in did not close the session")
	}
}

// Stalwart's verb reader skips leading spaces and every CR and ends a verb at
// any whitespace, so each of these is an AUTH or a DATA to Stalwart. None of
// them may reach it.
func TestSMTPLinesStalwartWouldReadDifferently(t *testing.T) {
	for _, in := range []string{
		" AUTH PLAIN " + plain("", "bob@i10.test", rightPassword),
		"AUTH\tPLAIN " + plain("", "bob@i10.test", rightPassword),
		"AU\rTH PLAIN " + plain("", "bob@i10.test", rightPassword),
		" DATA",
		"EHLO a\x00b",
	} {
		t.Run(strconv.Quote(in), func(t *testing.T) {
			// What the fake (Stalwart's rules) would have made of it.
			if v, _, ok := stalwartSMTPVerb(in + "\r\n"); !ok || (v != "AUTH" && v != "DATA" && v != "EHLO") {
				t.Fatalf("the Stalwart port reads %q as %q, %v: the test no longer proves anything", in, v, ok)
			}
			h := startFront(t, SMTP, alice(), nil)
			c := h.dial()
			c.until("220")
			c.send(in + "\r\n")
			if got := c.line(); !strings.HasPrefix(got, "500") {
				t.Fatalf("answered %q", got)
			}
			if !c.closed(2 * time.Second) {
				t.Fatal("still open")
			}
			if heard := h.upstream.commands(); len(heard) != 0 {
				t.Fatalf("forwarded %q", heard)
			}
		})
	}
}

func TestSMTPForwardsOnlyRebuiltCommands(t *testing.T) {
	h := startFront(t, SMTP, alice(), nil)
	c := h.dial()
	c.until("220")
	for _, l := range []string{"ehlo me.example", "NOOP whatever", "RSET", "MAIL FROM:<a@b>", "VRFY bob"} {
		c.send(l + "\r\n")
		c.until("")
		for {
			// EHLO answers several lines.
			if l != "ehlo me.example" {
				break
			}
			if got := c.line(); strings.HasPrefix(got, "250 ") {
				break
			}
		}
	}
	want := []string{"EHLO me.example", "NOOP", "RSET"}
	if got := h.upstream.commands(); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("Stalwart heard %q, want %q", got, want)
	}
}

func TestDatabaseDownAnswersSMTPSignInsUnavailable(t *testing.T) {
	// No lookup, no account to mint a token for: answered here as temporary,
	// and nothing is forwarded.
	accts := alice()
	accts.failAll = true
	h := startFront(t, SMTP, accts, nil)
	c := h.dial()
	c.until("220")
	c.send("AUTH PLAIN " + plain("", "alice@i10.test", rightPassword) + "\r\n")
	if got := c.line(); !strings.HasPrefix(got, "454 ") {
		t.Fatalf("answered %q", got)
	}
	for _, cmd := range h.upstream.commands() {
		if strings.HasPrefix(cmd, "AUTH") {
			t.Fatalf("forwarded %q", cmd)
		}
	}
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestASlowSweepWaitsLongerInsteadOfRunningBackToBack(t *testing.T) {
	s := &Sweeper{Interval: time.Second}
	if got := s.nextWait(SweepStats{Query: 20 * time.Millisecond}); got != time.Second {
		t.Fatalf("a fast sweep waits %s, want the interval", got)
	}
	if got := s.nextWait(SweepStats{Query: 600 * time.Millisecond}); got != 3*time.Second {
		t.Fatalf("a 600ms sweep waits %s, want 3s (a fifth of the backend)", got)
	}
}
