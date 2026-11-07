package passthrough

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/okta"
	"github.com/i10-tech/i10/services/authd/internal/okta/oktatest"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

const (
	laneEmail = "carol@acme.test"
	lanePass  = "c4rol-s3cret"
)

// answerSource answers every connection the same way.
type answerSource struct{ a *Answer }

func (s answerSource) Fetch(context.Context, string) (*Answer, error) { return s.a, nil }

func oktaAnswer(s okta.Settings) *Answer { return &Answer{Lane: LaneOkta, Okta: &s} }

func ldapAnswer() *Answer {
	return &Answer{Lane: LaneLDAP, LDAP: &Settings{
		Host: "ldap.acme.test", Port: 636, TLSMode: TLSModeLDAPS, SearchBase: "dc=acme",
		UserFilter: "(mail={email})", BindDN: "cn=svc", BindSecret: "s",
	}}
}

// countingBinder is a binder whose directory is down, and the number of times it
// was dialled.
func countingBinder() (*Binder, *atomic.Int32) {
	var dials atomic.Int32
	return &Binder{
		Resolver: oktatest.PublicResolver{},
		Dial: func(context.Context, string, string) (net.Conn, error) {
			dials.Add(1)
			return nil, errors.New("directory down")
		},
	}, &dials
}

// untouchedBinder fails the test if it is ever used to connect.
func untouchedBinder(t *testing.T) *Binder {
	b, dials := countingBinder()
	t.Cleanup(func() {
		if n := dials.Load(); n != 0 {
			t.Errorf("the LDAP walk opened %d connections", n)
		}
	})
	return b
}

func managedAccount() projection.Account {
	return projection.Account{ClerkUserID: "user_carol", Email: laneEmail, Managed: true, ManagedConnection: "c1"}
}

// ── The lane is the API's answer, and the lanes never answer for each other ──

func TestAnOktaConnectionIsAskedOfOktaAndNeverOfTheDirectory(t *testing.T) {
	okt := oktatest.Start(t)
	svc := NewService(answerSource{oktaAnswer(okt.Settings())}, untouchedBinder(t), okt.Client())

	res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
	if res.Outcome != Verified || res.Lane != LaneOkta {
		t.Fatalf("got %+v", res)
	}
	if calls := okt.Calls(); len(calls) != 1 || calls[0].Form.Get("username") != laneEmail {
		t.Fatalf("Okta saw %d calls, want one for the account's address", len(calls))
	}
}

func TestAnLDAPConnectionIsAskedOfTheDirectoryAndNeverOfOkta(t *testing.T) {
	okt := oktatest.Start(t)
	binder, dials := countingBinder()
	svc := NewService(answerSource{ldapAnswer()}, binder, okt.Client())

	res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
	if res.Outcome != Unavailable || res.Reason != ReasonDialFailed || res.Lane != LaneLDAP {
		t.Fatalf("got %+v", res)
	}
	if dials.Load() != 1 || okt.Count() != 0 {
		t.Fatalf("directory dialled %d times, Okta saw %d calls; want 1 and 0", dials.Load(), okt.Count())
	}
}

// An answer that names a lane without its settings is a broken answer, never a
// reason to ask the other lane.
func TestAnAnswerThatIsNotWholeIsUnavailable(t *testing.T) {
	okt := oktatest.Start(t)
	for name, a := range map[string]*Answer{
		"okta without settings": {Lane: LaneOkta},
		"ldap without settings": {Lane: LaneLDAP},
		"no lane":               {Okta: &okt2},
		"a lane nobody knows":   {Lane: "entra", Okta: &okt2},
	} {
		t.Run(name, func(t *testing.T) {
			svc := NewService(answerSource{a}, untouchedBinder(t), okt.Client())
			res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
			if res.Outcome != Unavailable || res.Reason != ReasonBadSettings || okt.Count() != 0 {
				t.Fatalf("got %+v after %d Okta calls", res, okt.Count())
			}
		})
	}
}

var okt2 = okta.Settings{Issuer: oktatest.Issuer, ClientID: oktatest.ClientID}

func TestMalformedOktaSettingsAreUnavailableWithoutACall(t *testing.T) {
	okt := oktatest.Start(t)
	bad := okta.Settings{Issuer: "http://acme.okta.com/oauth2/default", ClientID: oktatest.ClientID}
	svc := NewService(answerSource{oktaAnswer(bad)}, untouchedBinder(t), okt.Client())
	res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
	if res.Outcome != Unavailable || res.Reason != okta.ReasonBadSettings || okt.Count() != 0 {
		t.Fatalf("got %+v after %d Okta calls", res, okt.Count())
	}
}

func TestAnOffConnectionNeverReachesEitherLane(t *testing.T) {
	okt := oktatest.Start(t)
	svc := NewService(answerSource{nil}, untouchedBinder(t), okt.Client())
	res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
	if res.Outcome != Rejected || res.Reason != ReasonPassthroughOff || res.Lane != "" || okt.Count() != 0 {
		t.Fatalf("got %+v after %d Okta calls", res, okt.Count())
	}
}

// ── What the verifier reports ────────────────────────────────────────────

func lanedVerifier(t *testing.T, src Source, okt *oktatest.Server, log *slog.Logger) verify.Verifier {
	t.Helper()
	binder, _ := countingBinder()
	r := &ManagedResolver{
		Unmanaged: clerkStub{},
		Directory: NewService(src, binder, okt.Client()),
		Log:       log,
	}
	a := managedAccount()
	v, err := r.Resolve(context.Background(), &a)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// ⚠ THE NAME DOES NOT CARRY THE LANE (the resolver does no I/O), so the cache
// limit does the work: only an Okta success may be remembered, and briefly.
func TestOnlyAnOktaSuccessMayBeCachedAndOnlyBriefly(t *testing.T) {
	okt := oktatest.Start(t)
	a := managedAccount()

	cases := map[string]struct {
		answer *Answer
		want   time.Duration
	}{
		"okta":          {oktaAnswer(okt.Settings()), OktaMaxCacheTTL},
		"ldap":          {ldapAnswer(), 0},
		"off":           {nil, 0},
		"a broken lane": {&Answer{Lane: LaneOkta}, 0},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			v := lanedVerifier(t, answerSource{tc.answer}, okt, nil)
			limit := v.(verify.CacheLimit)
			// Before it has been asked, nothing may be stored.
			if got := limit.MaxCacheTTL(); got != 0 {
				t.Fatalf("limit before Verify = %s, want 0", got)
			}
			_, _ = v.Verify(context.Background(), &a, lanePass)
			if got := limit.MaxCacheTTL(); got != tc.want {
				t.Fatalf("limit = %s, want %s", got, tc.want)
			}
		})
	}
	if OktaMaxCacheTTL != 15*time.Minute {
		t.Errorf("OktaMaxCacheTTL = %s: only a verified event hook may lift it (issue #383, step 2b)", OktaMaxCacheTTL)
	}
}

func TestTheOktaLaneSharesTheDirectoryFailureBudget(t *testing.T) {
	okt := oktatest.Start(t)
	v := lanedVerifier(t, answerSource{oktaAnswer(okt.Settings())}, okt, nil)
	b := v.Budget()
	if b == nil || b.Max != 3 || b.Window != 15*time.Minute {
		t.Fatalf("Budget = %+v, want 3 per 15 minutes: Okta locks the real account at ten", b)
	}
	if v.Timeout() > verify.MaxTimeout || v.Timeout() < okta.RequestTimeout {
		t.Errorf("Timeout = %s, want it to hold one Okta request (%s) and fit verify.MaxTimeout", v.Timeout(), okta.RequestTimeout)
	}
}

func captured() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

// ⚠ "YOUR ORGANISATION REQUIRES MFA FOR MAIL" HAS TO BE TELLABLE FROM A WRONG
// PASSWORD, in the log, so the console can explain it.
func TestTheMFAReasonIsLoggedDistinctlyFromAWrongPassword(t *testing.T) {
	a := managedAccount()
	for name, tc := range map[string]struct {
		reply  oktatest.Reply
		reason string
	}{
		"mfa required":   {oktatest.MFARequired, "reason=okta_mfa_required"},
		"wrong password": {oktatest.InvalidCredentials, "reason=okta_invalid_credentials"},
	} {
		t.Run(name, func(t *testing.T) {
			okt := oktatest.Start(t)
			okt.Respond(tc.reply)
			log, buf := captured()
			out, err := lanedVerifier(t, answerSource{oktaAnswer(okt.Settings())}, okt, log).
				Verify(context.Background(), &a, lanePass)
			if out != verify.Rejected || err != nil {
				t.Fatalf("Verify = (%v, %v)", out, err)
			}
			line := buf.String()
			if !strings.Contains(line, tc.reason) || !strings.Contains(line, "lane=okta") {
				t.Errorf("log %q does not say %s", line, tc.reason)
			}
			other := "reason=okta_invalid_credentials"
			if tc.reason == other {
				other = "reason=okta_mfa_required"
			}
			if strings.Contains(line, other) {
				t.Errorf("log %q says %s too", line, other)
			}
			if strings.Contains(line, lanePass) {
				t.Errorf("the password reached the log: %q", line)
			}
		})
	}
}

// A misconfigured org is the customer's to fix: unavailable, with the reason in
// the error, and never the password.
func TestAnOrgThatRefusesOurClientIsUnavailableNotARejection(t *testing.T) {
	okt := oktatest.Start(t)
	okt.Respond(oktatest.InvalidClient)
	a := managedAccount()
	out, err := lanedVerifier(t, answerSource{oktaAnswer(okt.Settings())}, okt, nil).
		Verify(context.Background(), &a, lanePass)
	if out != verify.Unavailable || err == nil || !strings.Contains(err.Error(), "okta_config_invalid_client") {
		t.Fatalf("Verify = (%v, %v)", out, err)
	}
	if strings.Contains(err.Error(), lanePass) {
		t.Errorf("the password reached the error: %v", err)
	}
}
