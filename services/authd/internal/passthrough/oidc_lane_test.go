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

	"github.com/i10-tech/i10/services/authd/internal/oidc"
	"github.com/i10-tech/i10/services/authd/internal/oidc/oidctest"
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

func oidcAnswer(s oidc.Settings) *Answer { return &Answer{Lane: LaneOIDC, OIDC: &s} }

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
		Resolver: oidctest.PublicResolver{},
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

func TestAnOIDCConnectionIsAskedOfItsProviderAndNeverOfTheDirectory(t *testing.T) {
	for _, f := range oidctest.All {
		t.Run(f.Preset, func(t *testing.T) {
			srv := oidctest.Start(t)
			svc := NewService(answerSource{oidcAnswer(f.Settings())}, untouchedBinder(t), srv.Client())

			res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
			if res.Outcome != Verified || res.Lane != LaneOIDC || res.Preset != f.Preset {
				t.Fatalf("got %+v", res)
			}
			if calls := srv.Calls(); len(calls) != 1 || calls[0].Form.Get("username") != laneEmail || calls[0].Path != f.Path() {
				t.Fatalf("the provider saw %d calls, want one for the account's address at %s", len(calls), f.Path())
			}
		})
	}
}

func TestAnLDAPConnectionIsAskedOfTheDirectoryAndNeverOfTheProvider(t *testing.T) {
	srv := oidctest.Start(t)
	binder, dials := countingBinder()
	svc := NewService(answerSource{ldapAnswer()}, binder, srv.Client())

	res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
	if res.Outcome != Unavailable || res.Reason != ReasonDialFailed || res.Lane != LaneLDAP {
		t.Fatalf("got %+v", res)
	}
	if dials.Load() != 1 || srv.Count() != 0 {
		t.Fatalf("directory dialled %d times, the provider saw %d calls; want 1 and 0", dials.Load(), srv.Count())
	}
}

// An answer that names a lane without its settings is a broken answer, never a
// reason to ask the other lane.
func TestAnAnswerThatIsNotWholeIsUnavailable(t *testing.T) {
	srv := oidctest.Start(t)
	whole := oidctest.Okta.Settings()
	for name, a := range map[string]*Answer{
		"oidc without settings": {Lane: LaneOIDC},
		"ldap without settings": {Lane: LaneLDAP},
		"no lane":               {OIDC: &whole},
		"a lane nobody knows":   {Lane: "entra", OIDC: &whole},
		// The lane the API used to call it: only ever read off the wire.
		"the old wire name": {Lane: laneOktaWire, OIDC: &whole},
	} {
		t.Run(name, func(t *testing.T) {
			svc := NewService(answerSource{a}, untouchedBinder(t), srv.Client())
			res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
			if res.Outcome != Unavailable || res.Reason != ReasonBadSettings || srv.Count() != 0 {
				t.Fatalf("got %+v after %d provider calls", res, srv.Count())
			}
		})
	}
}

func TestMalformedOIDCSettingsAreUnavailableWithoutACall(t *testing.T) {
	srv := oidctest.Start(t)
	for name, mutate := range map[string]func(*oidc.Settings){
		"http":              func(s *oidc.Settings) { s.TokenEndpoint = "http://example.com/oauth2/default/v1/token" },
		"a foreign host":    func(s *oidc.Settings) { s.TokenEndpoint = "https://evil.example.org/oauth2/default/v1/token" },
		"an unknown preset": func(s *oidc.Settings) { s.Preset = "azure" },
		"a client secret":   func(s *oidc.Settings) { s.Extra = map[string]string{"client_secret": "x"} },
		"no token endpoint": func(s *oidc.Settings) { s.TokenEndpoint = "" },
	} {
		t.Run(name, func(t *testing.T) {
			bad := oidctest.Okta.Settings()
			mutate(&bad)
			svc := NewService(answerSource{oidcAnswer(bad)}, untouchedBinder(t), srv.Client())
			res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
			if res.Outcome != Unavailable || res.Reason != oidc.ReasonBadSettings || srv.Count() != 0 {
				t.Fatalf("got %+v after %d provider calls", res, srv.Count())
			}
		})
	}
}

func TestAnOffConnectionNeverReachesEitherLane(t *testing.T) {
	srv := oidctest.Start(t)
	svc := NewService(answerSource{nil}, untouchedBinder(t), srv.Client())
	res := svc.Bind(context.Background(), "c1", laneEmail, lanePass)
	if res.Outcome != Rejected || res.Reason != ReasonPassthroughOff || res.Lane != "" || srv.Count() != 0 {
		t.Fatalf("got %+v after %d provider calls", res, srv.Count())
	}
}

// ── What the verifier reports ────────────────────────────────────────────

func lanedVerifier(t *testing.T, src Source, srv *oidctest.Server, log *slog.Logger) verify.Verifier {
	t.Helper()
	binder, _ := countingBinder()
	r := &ManagedResolver{
		Unmanaged: clerkStub{},
		Directory: NewService(src, binder, srv.Client()),
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
// limit does the work: only an OIDC success may be remembered, and briefly.
func TestOnlyAnOIDCSuccessMayBeCachedAndOnlyBriefly(t *testing.T) {
	srv := oidctest.Start(t)
	a := managedAccount()

	cases := map[string]struct {
		answer *Answer
		want   time.Duration
	}{
		"okta":          {oidcAnswer(oidctest.Okta.Settings()), OIDCMaxCacheTTL},
		"keycloak":      {oidcAnswer(oidctest.Keycloak.Settings()), OIDCMaxCacheTTL},
		"auth0":         {oidcAnswer(oidctest.Auth0.Settings()), OIDCMaxCacheTTL},
		"ldap":          {ldapAnswer(), 0},
		"off":           {nil, 0},
		"a broken lane": {&Answer{Lane: LaneOIDC}, 0},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			v := lanedVerifier(t, answerSource{tc.answer}, srv, nil)
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
	if OIDCMaxCacheTTL != 15*time.Minute {
		t.Errorf("OIDCMaxCacheTTL = %s: no provider here tells authd about a password change, so only a verified Okta event hook may lift it (issue #383, step 2b)", OIDCMaxCacheTTL)
	}
}

func TestTheOIDCLaneSharesTheDirectoryFailureBudget(t *testing.T) {
	srv := oidctest.Start(t)
	v := lanedVerifier(t, answerSource{oidcAnswer(oidctest.Okta.Settings())}, srv, nil)
	b := v.Budget()
	if b == nil || b.Max != 3 || b.Window != 15*time.Minute {
		t.Fatalf("Budget = %+v, want 3 per 15 minutes: a provider locks the real account", b)
	}
	if v.Timeout() > verify.MaxTimeout || v.Timeout() < oidc.RequestTimeout {
		t.Errorf("Timeout = %s, want it to hold one provider request (%s) and fit verify.MaxTimeout", v.Timeout(), oidc.RequestTimeout)
	}
}

func captured() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewTextHandler(&buf, nil)), &buf
}

// ⚠ "YOUR ORGANISATION REQUIRES MFA FOR MAIL" HAS TO BE TELLABLE FROM A WRONG
// PASSWORD, in the log, so the console can explain it. The preset is logged too,
// because what a provider means by it is the preset's.
func TestTheMFAReasonIsLoggedDistinctlyFromAWrongPassword(t *testing.T) {
	a := managedAccount()
	for name, tc := range map[string]struct {
		fixture oidctest.Fixture
		reply   oidctest.Reply
		reason  string
	}{
		"okta mfa":       {oidctest.Okta, oidctest.OktaMFARequired, "reason=oidc_mfa_required"},
		"okta wrong":     {oidctest.Okta, oidctest.OktaInvalidCredentials, "reason=oidc_invalid_credentials"},
		"auth0 mfa":      {oidctest.Auth0, oidctest.Auth0MFARequired, "reason=oidc_mfa_required"},
		"fusionauth mfa": {oidctest.FusionAuth, oidctest.FusionAuthMFARequired, "reason=oidc_mfa_required"},
		"keycloak wrong": {oidctest.Keycloak, oidctest.KeycloakInvalidCredentials, "reason=oidc_invalid_credentials"},
		"auth0 locked":   {oidctest.Auth0, oidctest.Auth0AccountBlocked, "reason=oidc_account_locked"},
	} {
		t.Run(name, func(t *testing.T) {
			srv := oidctest.Start(t)
			srv.Respond(tc.reply)
			log, buf := captured()
			out, err := lanedVerifier(t, answerSource{oidcAnswer(tc.fixture.Settings())}, srv, log).
				Verify(context.Background(), &a, lanePass)
			if out != verify.Rejected || err != nil {
				t.Fatalf("Verify = (%v, %v)", out, err)
			}
			line := buf.String()
			if !strings.Contains(line, tc.reason) || !strings.Contains(line, "lane=oidc") || !strings.Contains(line, "preset="+tc.fixture.Preset) {
				t.Errorf("log %q does not say %s for %s", line, tc.reason, tc.fixture.Preset)
			}
			if strings.Contains(line, lanePass) {
				t.Errorf("the password reached the log: %q", line)
			}
		})
	}
}

// A misconfigured provider is the customer's to fix: unavailable, with the reason
// in the error, and never the password.
func TestAProviderThatRefusesOurClientIsUnavailableNotARejection(t *testing.T) {
	srv := oidctest.Start(t)
	srv.Respond(oidctest.InvalidClient)
	a := managedAccount()
	out, err := lanedVerifier(t, answerSource{oidcAnswer(oidctest.Okta.Settings())}, srv, nil).
		Verify(context.Background(), &a, lanePass)
	if out != verify.Unavailable || err == nil || !strings.Contains(err.Error(), "oidc_config_invalid_client") {
		t.Fatalf("Verify = (%v, %v)", out, err)
	}
	if strings.Contains(err.Error(), lanePass) {
		t.Errorf("the password reached the error: %v", err)
	}
}
