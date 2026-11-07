package ldapsrv_test

import (
	"context"
	"net/netip"
	"sync"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/okta"
	"github.com/i10-tech/i10/services/authd/internal/okta/oktatest"
	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// An account an Okta connection manages is asked of its company's Okta org
// (#383, B9). These drive the whole bind path against a fake token endpoint, and
// pin what matters about it: Okta's answers reach the client as the right LDAP
// code, a setup problem is "unavailable" and never a wrong password, the real
// account's lockout budget holds, and Clerk is never asked.

const (
	oktaMFAPass = "carol-needs-mfa"
)

// laneSource answers every connection with one answer, which a test can swap.
type laneSource struct {
	mu sync.Mutex
	a  *passthrough.Answer
}

func (l *laneSource) set(a *passthrough.Answer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.a = a
}

func (l *laneSource) Fetch(context.Context, string) (*passthrough.Answer, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.a, nil
}

func oktaLane(s okta.Settings) *passthrough.Answer {
	return &passthrough.Answer{Lane: passthrough.LaneOkta, Okta: &s}
}

// carolsOrg is an Okta org that knows carolPass, wants a second factor for
// oktaMFAPass, and refuses everything else.
func carolsOrg(t *testing.T) *oktatest.Server {
	okt := oktatest.Start(t)
	okt.Handle(func(r oktatest.Request) oktatest.Reply {
		switch r.Form.Get("password") {
		case carolPass:
			return oktatest.Granted
		case oktaMFAPass:
			return oktatest.MFARequired
		}
		return oktatest.InvalidCredentials
	})
	return okt
}

type oktaRig struct {
	addr   string
	okt    *oktatest.Server
	lane   *laneSource
	budget *fakeBudgetStore
	clerk  *fakeVerifier
	store  *fakeStore
}

func newOktaRig(t *testing.T, okt *oktatest.Server, cache *credcache.Cache) *oktaRig {
	t.Helper()
	r := &oktaRig{
		okt:   okt,
		lane:  &laneSource{a: oktaLane(okt.Settings())},
		clerk: &fakeVerifier{outcome: verify.Verified}, // would say yes to anything
		store: managedStore(),
	}
	svc := passthrough.NewService(r.lane, &passthrough.Binder{}, okt.Client())
	r.addr, r.budget = managedFixture(t, r.store, r.clerk, svc, cache)
	return r
}

func (r *oktaRig) bind(t *testing.T, password string) uint16 {
	t.Helper()
	return bindCarol(t, r.addr, password)
}

// ── Okta's answers, as LDAP codes ────────────────────────────────────────

func TestAnOktaManagedAccountBindsThroughOkta(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), nil)

	if got := r.bind(t, "not-her-password"); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("wrong password = %d, want invalidCredentials", got)
	}
	if n := r.budget.count(carolUID); n != 1 {
		t.Fatalf("a wrong password left %d slots spent, want 1", n)
	}
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("correct password = %d", got)
	}
	if n := r.budget.count(carolUID); n != 1 {
		t.Fatalf("a success changed the slots spent to %d, want it to stay 1", n)
	}
	if r.clerk.callCount() != 0 {
		t.Fatalf("Clerk was asked %d times about an Okta-managed account", r.clerk.callCount())
	}
	calls := r.okt.Calls()
	if len(calls) != 2 || calls[1].Form.Get("username") != carolMail || calls[1].Form.Get("client_id") != oktatest.ClientID {
		t.Fatalf("Okta saw %d calls", len(calls))
	}
}

// The right password on an app that still wants a second factor is a refusal,
// and keeps its slot: Okta counted it.
func TestAnOrgThatStillWantsMFAIsARefusalNotAnOutage(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), nil)
	if got := r.bind(t, oktaMFAPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if n := r.budget.count(carolUID); n != 1 {
		t.Fatalf("%d slots spent, want 1", n)
	}
}

// ⚠ AN OKTA OUTAGE OR A WRONG SETUP IS NEVER "WRONG PASSWORD", and neither spends
// the slots that keep i10 from locking the real account.
func TestAnOrgThatCannotAnswerIsUnavailableAndGivesTheSlotBack(t *testing.T) {
	for name, reply := range map[string]oktatest.Reply{
		"down":                      oktatest.Down,
		"rate limited":              oktatest.RateLimited,
		"our client is refused":     oktatest.InvalidClient,
		"a 404 where the issuer is": {Status: 404, Body: `{"errorCode":"E0000007"}`},
		"a redirect":                {Status: 302, Header: map[string]string{"Location": "https://elsewhere.example/"}},
		"a 200 that is not a token": {Status: 200, Body: `{}`},
	} {
		t.Run(name, func(t *testing.T) {
			okt := carolsOrg(t)
			okt.Respond(reply)
			r := newOktaRig(t, okt, nil)

			for i := 1; i <= 5; i++ { // more than the budget: none of them is a failure
				if got := r.bind(t, carolPass); got != goldapclient.LDAPResultUnavailable {
					t.Fatalf("bind %d: result = %d, want unavailable (52), never 49", i, got)
				}
			}
			reserves, releases := r.budget.counts()
			if reserves != 5 || releases != 5 || r.budget.count(carolUID) != 0 {
				t.Fatalf("reserves=%d releases=%d spent=%d; every outage must give its slot back",
					reserves, releases, r.budget.count(carolUID))
			}
			if r.clerk.callCount() != 0 {
				t.Fatalf("Clerk was asked %d times", r.clerk.callCount())
			}

			// The org comes back and the person's real password works at once.
			okt.Handle(func(oktatest.Request) oktatest.Reply { return oktatest.Granted })
			if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
				t.Fatalf("after the outage: result = %d, want success", got)
			}
		})
	}
}

// ── The lockout budget ───────────────────────────────────────────────────

// ⚠ OKTA LOCKS THE REAL ACCOUNT AT TEN, AND A LOCKED ONE ANSWERS LIKE A WRONG
// PASSWORD. Three distinct failures reach Okta; then it is left alone.
func TestOktaIsAskedAtMostThreeTimesPerWindowForWrongPasswords(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), nil)

	for i := 1; i <= 3; i++ {
		if got := r.bind(t, wrong(i)); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("failure %d: result = %d, want 49", i, got)
		}
	}
	for i := 4; i <= 6; i++ {
		if got := r.bind(t, wrong(i)); got != goldapclient.LDAPResultBusy {
			t.Fatalf("failure %d past the budget gave %d, want busy (51)", i, got)
		}
	}
	if n := r.okt.Count(); n != 3 {
		t.Fatalf("Okta was asked %d times, want it to stay at 3", n)
	}

	r.budget.advance(passthrough.FailureBudget.Window)
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("after the window: result = %d, want success", got)
	}
}

// A phone retrying its stale password costs Okta one call, not one per retry.
func TestAnIdenticalRetryIsAnsweredWithoutAskingOkta(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), nil)
	for i := 0; i < 5; i++ {
		if got := r.bind(t, "stale-saved-password"); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("retry %d: result = %d, want 49", i, got)
		}
	}
	if n := r.okt.Count(); n != 1 {
		t.Fatalf("Okta was asked %d times for 5 identical retries, want 1", n)
	}
	if reserves, _ := r.budget.counts(); reserves != 1 || r.budget.count(carolUID) != 1 {
		t.Fatalf("reserves=%d spent=%d, want 1 and 1", reserves, r.budget.count(carolUID))
	}
}

// ── The cache ────────────────────────────────────────────────────────────

// An Okta success may be remembered (briefly: see passthrough.OktaMaxCacheTTL,
// pinned in the passthrough package), so a client's connection burst is one call.
func TestAnOktaSuccessIsRememberedAndAWrongPasswordIsNot(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), credcache.New(2*time.Hour))

	for i := 0; i < 3; i++ {
		if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
			t.Fatalf("bind %d: result = %d", i, got)
		}
	}
	if n := r.okt.Count(); n != 1 {
		t.Fatalf("Okta was asked %d times for 3 binds, want 1", n)
	}
	// A different password is not the remembered one.
	if got := r.bind(t, "not-her-password"); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("a wrong password after a success gave %d, want invalidCredentials", got)
	}
	if n := r.okt.Count(); n != 2 {
		t.Fatalf("Okta was asked %d times, want the wrong password to reach it", n)
	}
}

// The raised credential epoch is what a verified event hook will use (step 2b),
// and what the API raises when a connection's Okta settings change.
func TestARaisedCredentialEpochMakesTheNextBindAskOktaAgain(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), credcache.New(2*time.Hour))
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("first bind = %d", got)
	}

	// Okta now refuses that password, but the remembered success still stands:
	// this is the window the epoch exists to close.
	r.okt.Respond(oktatest.InvalidCredentials)
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("remembered bind = %d", got)
	}

	r.store.accounts[2].CredentialEpoch++
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("after the epoch rose: result = %d, want invalidCredentials", got)
	}
	if n := r.okt.Count(); n != 2 {
		t.Fatalf("Okta was asked %d times, want the raised epoch to cost exactly one more", n)
	}
}

// ── Egress ───────────────────────────────────────────────────────────────

// ⚠ THE ISSUER IS A CUSTOMER'S CHOICE. One that resolves to the cluster is
// unavailable, nothing is sent, and no slot is spent.
func TestAnIssuerThatResolvesToTheClusterIsNeverConnectedTo(t *testing.T) {
	okt := carolsOrg(t)
	clerk := &fakeVerifier{outcome: verify.Verified}
	client := okt.Client()
	client.Resolver = privateOnly{}
	svc := passthrough.NewService(&laneSource{a: oktaLane(okt.Settings())}, &passthrough.Binder{}, client)
	addr, budget := managedFixture(t, managedStore(), clerk, svc, nil)

	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52)", got)
	}
	if okt.Count() != 0 {
		t.Fatalf("a private issuer received %d requests", okt.Count())
	}
	if n := budget.count(carolUID); n != 0 {
		t.Fatalf("a connection we refused to use left %d slots spent, want 0", n)
	}
	if clerk.callCount() != 0 {
		t.Fatalf("Clerk was asked %d times", clerk.callCount())
	}
}

type privateOnly struct{}

func (privateOnly) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("10.96.0.10")}, nil // the cluster DNS
}

// ── Lanes, and never Clerk ───────────────────────────────────────────────

// A connection that changes lane is asked of the new one at once, and turning it
// off is a refusal - never Clerk, never the lane it left.
func TestAConnectionThatChangesLaneIsAskedOfTheNewLaneNotTheOldOne(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), nil)
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("on Okta: %d", got)
	}

	// To a directory that cannot be reached.
	r.lane.set(&passthrough.Answer{Lane: passthrough.LaneLDAP, LDAP: &passthrough.Settings{
		Host: "127.0.0.1", Port: 636, TLSMode: passthrough.TLSModeLDAPS, SearchBase: "dc=x",
		UserFilter: "(mail={email})", BindDN: "cn=svc", BindSecret: "s",
	}})
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("on LDAP: %d, want unavailable", got)
	}

	// Off.
	r.lane.set(nil)
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("off: %d, want invalidCredentials", got)
	}
	if n := r.okt.Count(); n != 1 {
		t.Fatalf("Okta was asked %d times, want only the first bind", n)
	}
	if r.clerk.callCount() != 0 {
		t.Fatalf("Clerk was asked %d times", r.clerk.callCount())
	}
}

// Suspension is checked before any lane is, so a warm Okta entry cannot open a
// mailbox the directory switched off.
func TestASuspendedOktaMailboxIsRefusedEvenWithAWarmCache(t *testing.T) {
	r := newOktaRig(t, carolsOrg(t), credcache.New(time.Hour))
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("bind before the suspension = %d", got)
	}
	r.store.accounts[2].Suspended = true
	if got := r.bind(t, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("a suspended mailbox bound from the cache: result = %d", got)
	}
}
