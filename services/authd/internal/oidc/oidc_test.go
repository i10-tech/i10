package oidc_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/oidc"
	"github.com/i10-tech/i10/services/authd/internal/oidc/oidctest"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

const (
	email    = "carol@acme.test"
	password = "c4rol-s3cret"
)

func check(t *testing.T, s *oidctest.Server, f oidctest.Fixture) oidc.Result {
	t.Helper()
	return s.Client().Verify(context.Background(), f.Settings(), email, password)
}

func reply(status int, body string) oidctest.Reply { return oidctest.Reply{Status: status, Body: body} }

// ── The mapping table, one row at a time, for every preset ───────────────

func TestEveryAnswerMapsToTheTriState(t *testing.T) {
	type row struct {
		fixture oidctest.Fixture
		reply   oidctest.Reply
		want    verify.Outcome
		reason  string
	}
	rows := map[string]row{
		// ── Okta (probed against a real org, issue #383) ──
		"okta: a token": {oidctest.Okta, oidctest.Granted, verify.Verified, oidc.ReasonVerified},
		// invalid_grant is about the person's credentials, so it is a rejection (and
		// keeps its budget slot) whatever it says.
		"okta: a wrong password, or a locked account": {oidctest.Okta, oidctest.OktaInvalidCredentials, verify.Rejected, oidc.ReasonInvalidCredentials},
		"okta: the app still wants a second factor":   {oidctest.Okta, oidctest.OktaMFARequired, verify.Rejected, oidc.ReasonMFARequired},
		"okta: an invalid_grant it has no words for": {
			oidctest.Okta, reply(400, `{"error":"invalid_grant","error_description":"The user is not assigned to the client application."}`),
			verify.Rejected, oidc.ReasonInvalidCredentials,
		},

		// ── Keycloak (https://phasetwo.io/blog/keycloak-invalid-grant/) ──
		"keycloak: wrong password, unknown user or lockout (401)": {oidctest.Keycloak, oidctest.KeycloakInvalidCredentials, verify.Rejected, oidc.ReasonInvalidCredentials},
		// The status differs between releases, so it is not what the mapping keys on.
		"keycloak: the same answer as a 400": {
			oidctest.Keycloak, reply(400, `{"error":"invalid_grant","error_description":"Invalid user credentials"}`),
			verify.Rejected, oidc.ReasonInvalidCredentials,
		},
		"keycloak: the account is disabled":      {oidctest.Keycloak, oidctest.KeycloakDisabled, verify.Rejected, oidc.ReasonAccountDisabled},
		"keycloak: a required action is pending": {oidctest.Keycloak, oidctest.KeycloakNotSetUp, verify.Rejected, oidc.ReasonActionRequired},
		"keycloak: direct grants are off for the client": {
			oidctest.Keycloak, oidctest.KeycloakDirectGrantsOff, verify.Unavailable, "oidc_config_unauthorized_client",
		},

		// ── Auth0 (https://auth0.com/docs/api/authentication/resource-owner-password-flow/get-token) ──
		"auth0: a wrong password (403 invalid_grant)":     {oidctest.Auth0, oidctest.Auth0WrongPassword, verify.Rejected, oidc.ReasonInvalidCredentials},
		"auth0: mfa_required":                             {oidctest.Auth0, oidctest.Auth0MFARequired, verify.Rejected, oidc.ReasonMFARequired},
		"auth0: the account was blocked by brute-force":   {oidctest.Auth0, oidctest.Auth0AccountBlocked, verify.Rejected, oidc.ReasonAccountLocked},
		"auth0: a blocked user":                           {oidctest.Auth0, oidctest.Auth0UserBlocked, verify.Rejected, oidc.ReasonAccountDisabled},
		"auth0: a blocked user, legacy wording":           {oidctest.Auth0, oidctest.Auth0LegacyBlocked, verify.Rejected, oidc.ReasonAccountDisabled},
		"auth0: access_denied":                            {oidctest.Auth0, oidctest.Auth0AccessDenied, verify.Rejected, oidc.ReasonInvalidCredentials},
		"auth0: the application lacks the password grant": {oidctest.Auth0, oidctest.Auth0GrantOff, verify.Unavailable, "oidc_config_unauthorized_client"},
		// ⚠ THE SAME CODE, ABOUT US: Auth0 throttling OUR address is not the person's
		// lock, and must not be charged to their budget.
		"auth0: suspicious-login throttling of our address": {oidctest.Auth0, oidctest.Auth0Suspicious, verify.Unavailable, oidc.ReasonRateLimited},

		// ── PingFederate (pf_oauth_grant_type_param.html) ──
		"ping: the validator refused": {oidctest.Ping, oidctest.PingInvalidCredentials, verify.Rejected, oidc.ReasonInvalidCredentials},
		// Its text is the customer's directory's, so nothing in it is a signal.
		"ping: an invalid_grant that talks about mfa": {
			oidctest.Ping, reply(400, `{"error":"invalid_grant","error_description":"MFA required; account locked; sign on policy"}`),
			verify.Rejected, oidc.ReasonInvalidCredentials,
		},

		// ── FusionAuth (https://fusionauth.io/docs/apis/oauth/oauth-error) ──
		"fusionauth: invalid_user_credentials": {oidctest.FusionAuth, oidctest.FusionAuthInvalidCredentials, verify.Rejected, oidc.ReasonInvalidCredentials},
		"fusionauth: two_factor_required":      {oidctest.FusionAuth, oidctest.FusionAuthMFARequired, verify.Rejected, oidc.ReasonMFARequired},
		"fusionauth: user_locked":              {oidctest.FusionAuth, oidctest.FusionAuthLocked, verify.Rejected, oidc.ReasonAccountLocked},
		"fusionauth: user_expired":             {oidctest.FusionAuth, oidctest.FusionAuthExpired, verify.Rejected, oidc.ReasonAccountDisabled},
		"fusionauth: change_password_required": {oidctest.FusionAuth, oidctest.FusionAuthChangePassword, verify.Rejected, oidc.ReasonActionRequired},
		"fusionauth: a client that wants a secret": {
			oidctest.FusionAuth, oidctest.FusionAuthClientAuthRequired, verify.Unavailable, "oidc_config_invalid_client",
		},
		"fusionauth: an invalid_request with a reason it has no row for": {
			oidctest.FusionAuth, reply(400, `{"error":"invalid_request","error_reason":"missing_grant_type"}`),
			verify.Unavailable, "oidc_config_invalid_request",
		},

		// ── Generic: RFC 6749 5.2 and the standard codes, nothing vendor-specific ──
		"generic: invalid_grant":            {oidctest.Generic, oidctest.GenericInvalidGrant, verify.Rejected, oidc.ReasonInvalidCredentials},
		"generic: mfa_required":             {oidctest.Generic, reply(403, `{"error":"mfa_required"}`), verify.Rejected, oidc.ReasonMFARequired},
		"generic: interaction_required":     {oidctest.Generic, reply(400, `{"error":"interaction_required"}`), verify.Rejected, oidc.ReasonActionRequired},
		"generic: text is not a signal":     {oidctest.Generic, reply(400, `{"error":"invalid_grant","error_description":"sign on policy: mfa"}`), verify.Rejected, oidc.ReasonInvalidCredentials},
		"generic: a vendor signal it lacks": {oidctest.Generic, oidctest.Auth0AccountBlocked, verify.Unavailable, oidc.ReasonRateLimited},
	}

	// Our customer's setup, an outage and a body that is not an answer: the same for
	// every preset.
	for _, f := range oidctest.All {
		name := f.Preset + ": "
		for n, r := range map[string]row{
			"invalid_client":     {f, oidctest.InvalidClient, verify.Unavailable, "oidc_config_invalid_client"},
			"invalid_client 400": {f, reply(400, `{"error":"invalid_client"}`), verify.Unavailable, "oidc_config_invalid_client"},
			"unauthorized_client": {
				f, reply(400, `{"error":"unauthorized_client","error_description":"The client is not authorized to use the provided grant type."}`),
				verify.Unavailable, "oidc_config_unauthorized_client",
			},
			"unsupported_grant_type": {f, reply(400, `{"error":"unsupported_grant_type"}`), verify.Unavailable, "oidc_config_unsupported_grant_type"},
			"invalid_scope":          {f, reply(400, `{"error":"invalid_scope"}`), verify.Unavailable, "oidc_config_invalid_scope"},
			"a 403":                  {f, reply(403, `{"errorCode":"E0000006"}`), verify.Unavailable, "oidc_config_unknown"},
			"a 404 page":             {f, reply(404, `<html>not found</html>`), verify.Unavailable, "oidc_config_unknown"},
			"a 400 that is not JSON": {f, reply(400, `nope`), verify.Unavailable, "oidc_config_unknown"},
			// Text of the provider's choosing never reaches a log line.
			"a hostile error code": {f, reply(400, `{"error":"x\nlevel=ERROR msg=pwned"}`), verify.Unavailable, "oidc_config_unknown"},

			"rate limited": {f, oidctest.RateLimited, verify.Unavailable, oidc.ReasonRateLimited},
			"a 500":        {f, reply(500, ""), verify.Unavailable, oidc.ReasonServerError},
			"a 502":        {f, reply(502, "bad gateway"), verify.Unavailable, oidc.ReasonServerError},
			"down":         {f, oidctest.Down, verify.Unavailable, oidc.ReasonServerError},

			// A 200 is a yes only with a token in it.
			"a 200 with no token":     {f, reply(200, `{"token_type":"Bearer"}`), verify.Unavailable, oidc.ReasonBadResponse},
			"a 200 that is not JSON":  {f, reply(200, `OK`), verify.Unavailable, oidc.ReasonBadResponse},
			"a 200 with an empty one": {f, reply(200, `{"access_token":""}`), verify.Unavailable, oidc.ReasonBadResponse},
			"a token":                 {f, oidctest.Granted, verify.Verified, oidc.ReasonVerified},
		} {
			rows[name+n] = r
		}
	}

	for name, tc := range rows {
		t.Run(name, func(t *testing.T) {
			s := oidctest.Start(t)
			s.Respond(tc.reply)
			got := check(t, s, tc.fixture)
			if got.Outcome != tc.want || got.Reason != tc.reason {
				t.Fatalf("got (%v, %q), want (%v, %q)", got.Outcome, got.Reason, tc.want, tc.reason)
			}
			if strings.Contains(got.Reason, password) {
				t.Errorf("the password reached the reason: %q", got.Reason)
			}
		})
	}
}

// ⚠ AN INVALID_GRANT IS A REJECTION EVEN WHEN ITS TEXT NAMES THE PASSWORD. Nothing
// the provider says is copied into the reason.
func TestNothingTheProviderSaysIsCopiedIntoTheReason(t *testing.T) {
	for _, f := range oidctest.All {
		t.Run(f.Preset, func(t *testing.T) {
			s := oidctest.Start(t)
			s.Respond(reply(400, `{"error":"invalid_grant","error_description":"bad password `+password+` for `+email+`"}`))
			got := check(t, s, f)
			if got.Outcome != verify.Rejected || strings.Contains(got.Reason, password) || strings.Contains(got.Reason, email) {
				t.Fatalf("got (%v, %q)", got.Outcome, got.Reason)
			}
		})
	}
}

// ── What is sent ─────────────────────────────────────────────────────────

func TestTheRequestIsThePasswordGrantAtTheFixturesTokenEndpoint(t *testing.T) {
	for _, f := range oidctest.All {
		t.Run(f.Preset, func(t *testing.T) {
			s := oidctest.Start(t)
			// Characters that break a hand-built form body.
			tricky := `p&ss=w rd+%26"é`
			got := s.Client().Verify(context.Background(), f.Settings(), email, tricky)
			if got.Outcome != verify.Verified {
				t.Fatalf("got %+v", got)
			}
			calls := s.Calls()
			if len(calls) != 1 {
				t.Fatalf("%d requests, want 1", len(calls))
			}
			r := calls[0]
			if r.Method != http.MethodPost || r.Path != f.Path() {
				t.Errorf("sent %s %s, want POST %s", r.Method, r.Path, f.Path())
			}
			if r.ContentType != "application/x-www-form-urlencoded" {
				t.Errorf("content type %q", r.ContentType)
			}
			want := map[string]string{
				"grant_type": "password",
				"username":   email,
				"password":   tricky,
				"scope":      "openid",
				"client_id":  f.ClientID,
			}
			for k, v := range f.Extra {
				want[k] = v
			}
			if f.Preset == oidc.PresetAuth0 {
				// A realm is the password-realm extension grant (Auth0 docs, "Realm support").
				want["grant_type"] = "http://auth0.com/oauth/grant-type/password-realm"
			}
			if len(r.Form) != len(want) {
				t.Errorf("form has %d fields, want %d: %v", len(r.Form), len(want), r.Form)
			}
			for k, v := range want {
				if r.Form.Get(k) != v {
					t.Errorf("%s = %q, want %q", k, r.Form.Get(k), v)
				}
			}
			// ⚠ A PUBLIC CLIENT: no client secret, no basic auth, nothing to hold.
			if r.Header.Get("Authorization") != "" || r.Form.Has("client_secret") || r.Form.Has("client_assertion") {
				t.Error("the request carries a client credential")
			}
			if r.Header.Get("User-Agent") != oidc.UserAgent {
				t.Errorf("User-Agent = %q", r.Header.Get("User-Agent"))
			}
		})
	}
}

func TestAnAuth0TenantWithoutARealmUsesThePlainPasswordGrant(t *testing.T) {
	s := oidctest.Start(t)
	f := oidctest.Auth0
	f.Extra = map[string]string{"audience": "https://mail.acme.test"}
	if got := check(t, s, f); got.Outcome != verify.Verified {
		t.Fatalf("got %+v", got)
	}
	form := s.Calls()[0].Form
	if form.Get("grant_type") != "password" || form.Has("realm") || form.Get("audience") != "https://mail.acme.test" {
		t.Errorf("form = %v", form)
	}
}

func TestAScopeOfTheOwnersIsSentInPlaceOfOpenid(t *testing.T) {
	s := oidctest.Start(t)
	f := oidctest.Keycloak
	f.Extra = map[string]string{"scope": "openid email"}
	if got := check(t, s, f); got.Outcome != verify.Verified {
		t.Fatalf("got %+v", got)
	}
	if got := s.Calls()[0].Form.Get("scope"); got != "openid email" {
		t.Errorf("scope = %q", got)
	}
}

func TestAnEmptyPasswordIsRefusedWithoutARequest(t *testing.T) {
	s := oidctest.Start(t)
	got := s.Client().Verify(context.Background(), oidctest.Okta.Settings(), email, "")
	if got.Outcome != verify.Rejected || got.Reason != oidc.ReasonEmptyPassword || s.Count() != 0 {
		t.Fatalf("got %+v after %d requests", got, s.Count())
	}
}

func TestBadSettingsAreUnavailableWithoutARequest(t *testing.T) {
	for name, mutate := range map[string]func(*oidc.Settings){
		"http":                  func(s *oidc.Settings) { s.TokenEndpoint = "http://example.com/oauth2/default/v1/token" },
		"a foreign token host":  func(s *oidc.Settings) { s.TokenEndpoint = "https://evil.example.org/oauth2/default/v1/token" },
		"a sibling host":        func(s *oidc.Settings) { s.TokenEndpoint = "https://evil.example.com/oauth2/default/v1/token" },
		"an unknown preset":     func(s *oidc.Settings) { s.Preset = "azure" },
		"no preset":             func(s *oidc.Settings) { s.Preset = "" },
		"a field the form owns": func(s *oidc.Settings) { s.Extra = map[string]string{"password": "x"} },
		"a client secret":       func(s *oidc.Settings) { s.Extra = map[string]string{"client_secret": "x"} },
	} {
		t.Run(name, func(t *testing.T) {
			s := oidctest.Start(t)
			settings := oidctest.Okta.Settings()
			mutate(&settings)
			got := s.Client().Verify(context.Background(), settings, email, password)
			if got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonBadSettings || s.Count() != 0 {
				t.Fatalf("got %+v after %d requests", got, s.Count())
			}
		})
	}
}

// ── Egress ───────────────────────────────────────────────────────────────

type answers map[string][]netip.Addr

func (a answers) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return a[host], nil
}

type failingResolver struct{}

func (failingResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return nil, errors.New("nxdomain")
}

// ⚠ A TOKEN ENDPOINT IS A CUSTOMER'S CHOICE. One that resolves anywhere non-public
// is never connected to, and nothing is sent.
func TestATokenEndpointThatResolvesAnywherePrivateIsNeverDialled(t *testing.T) {
	for name, addrs := range map[string][]netip.Addr{
		"loopback":     {netip.MustParseAddr("127.0.0.1")},
		"metadata":     {netip.MustParseAddr("169.254.169.254")},
		"private":      {netip.MustParseAddr("10.1.2.3")},
		"unique-local": {netip.MustParseAddr("fd00::1")},
		"mixed":        {netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("192.168.0.9")},
	} {
		t.Run(name, func(t *testing.T) {
			s := oidctest.Start(t)
			var dials atomic.Int32
			c := s.Client()
			c.Resolver = answers{oidctest.Host: addrs}
			c.Dial = func(context.Context, string, string) (net.Conn, error) {
				dials.Add(1)
				return nil, errors.New("must not be dialled")
			}
			got := c.Verify(context.Background(), oidctest.Okta.Settings(), email, password)
			if got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonHostBlocked {
				t.Fatalf("got %+v", got)
			}
			if dials.Load() != 0 || s.Count() != 0 {
				t.Fatalf("%d dials and %d requests reached a blocked host", dials.Load(), s.Count())
			}
		})
	}
}

// The connection goes to the vetted ADDRESS, whatever the name resolves to a
// moment later.
func TestTheDialIsToTheVettedAddressNotTheName(t *testing.T) {
	s := oidctest.Start(t)
	var dialled string
	c := s.Client()
	inner := c.Dial
	c.Dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		dialled = address
		return inner(ctx, network, address)
	}
	if got := c.Verify(context.Background(), oidctest.Okta.Settings(), email, password); got.Outcome != verify.Verified {
		t.Fatalf("got %+v", got)
	}
	if dialled != "93.184.216.34:443" {
		t.Errorf("dialled %q, want the vetted address on 443", dialled)
	}
}

func TestEveryTransportFailureIsUnavailableWithItsOwnReason(t *testing.T) {
	f := oidctest.Okta
	t.Run("dns", func(t *testing.T) {
		s := oidctest.Start(t)
		c := s.Client()
		c.Resolver = failingResolver{}
		if got := c.Verify(context.Background(), f.Settings(), email, password); got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonDNSFailed {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("dial", func(t *testing.T) {
		s := oidctest.Start(t)
		c := s.Client()
		c.Dial = func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("refused") }
		if got := c.Verify(context.Background(), f.Settings(), email, password); got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonDialFailed {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("a certificate nobody trusts", func(t *testing.T) {
		s := oidctest.Start(t)
		c := s.Client()
		c.RootCAs = nil
		got := c.Verify(context.Background(), f.Settings(), email, password)
		if got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonTLSFailed {
			t.Fatalf("got %+v", got)
		}
		if s.Count() != 0 {
			t.Error("a request was sent over an unverified connection")
		}
	})
	t.Run("a deadline", func(t *testing.T) {
		s := oidctest.Start(t)
		s.Handle(func(oidctest.Request) oidctest.Reply {
			time.Sleep(400 * time.Millisecond)
			return oidctest.Granted
		})
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		got := s.Client().Verify(ctx, f.Settings(), email, password)
		if got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonTimeout {
			t.Fatalf("got %+v", got)
		}
	})
}

// ⚠ A REDIRECT WOULD CARRY THE PASSWORD SOMEWHERE NOBODY CONFIGURED. It is the
// answer, and the Location is never requested.
func TestARedirectIsNeverFollowed(t *testing.T) {
	elsewhere := oidctest.Start(t)
	s := oidctest.Start(t)
	s.Respond(oidctest.Reply{Status: 307, Header: map[string]string{"Location": "https://" + elsewhere.Addr() + "/steal"}})
	got := check(t, s, oidctest.Okta)
	if got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonRedirected {
		t.Fatalf("got %+v", got)
	}
	if elsewhere.Count() != 0 {
		t.Fatalf("the redirect target received %d requests", elsewhere.Count())
	}
}

// A proxy named in the environment would carry the password where the guard
// cannot see it.
func TestAProxyInTheEnvironmentIsIgnored(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("https_proxy", "http://127.0.0.1:1")
	s := oidctest.Start(t)
	if got := check(t, s, oidctest.Okta); got.Outcome != verify.Verified {
		t.Fatalf("got %+v", got)
	}
}

// The answer is read up to a bound. A token past it is not a token.
func TestTheAnswerIsReadUpToABound(t *testing.T) {
	s := oidctest.Start(t)
	s.Respond(reply(200, `{"padding":"`+strings.Repeat("A", 1<<20)+`","access_token":"late"}`))
	got := check(t, s, oidctest.Okta)
	if got.Outcome != verify.Unavailable || got.Reason != oidc.ReasonBadResponse {
		t.Fatalf("got %+v", got)
	}
}

// ── Settings ─────────────────────────────────────────────────────────────

func TestEveryFixtureIsValid(t *testing.T) {
	for _, f := range oidctest.All {
		if err := f.Settings().Validate(); err != nil {
			t.Errorf("%s fixture refused: %v", f.Preset, err)
		}
	}
	if len(oidctest.All) != len(oidc.PresetNames()) {
		t.Errorf("%d fixtures for %d presets", len(oidctest.All), len(oidc.PresetNames()))
	}
}

func TestSettingsValidate(t *testing.T) {
	const id = "0oa1b2c3d4e5f6g7h8i9"
	okta := func(issuer, token string) oidc.Settings {
		return oidc.Settings{Preset: oidc.PresetOkta, Issuer: issuer, TokenEndpoint: token, ClientID: id}
	}
	good := []oidc.Settings{
		okta("https://acme.okta.com/oauth2/default", "https://acme.okta.com/oauth2/default/v1/token"),
		okta("https://acme.oktapreview.com/oauth2/aus1b2c3d4e5f6g7h8i9", "https://acme.oktapreview.com/oauth2/aus1b2c3d4e5f6g7h8i9/v1/token"),
		okta("https://id.acme.example/oauth2/default", "https://id.acme.example/oauth2/default/v1/token"),
		{Preset: oidc.PresetKeycloak, Issuer: "https://sso.acme.example/realms/acme", TokenEndpoint: "https://sso.acme.example/realms/acme/protocol/openid-connect/token", ClientID: "mail"},
		{Preset: oidc.PresetAuth0, Issuer: "https://acme.eu.auth0.com", TokenEndpoint: "https://acme.eu.auth0.com/oauth/token", ClientID: "Zk3q9XvYw0aB5cD7", Extra: map[string]string{"realm": "Employees", "audience": "https://mail"}},
		{Preset: oidc.PresetGeneric, Issuer: "https://idp.acme.example", TokenEndpoint: "https://idp.acme.example/token", ClientID: "mail"},
	}
	for _, s := range good {
		if err := s.Validate(); err != nil {
			t.Errorf("%+v refused: %v", s, err)
		}
	}

	const iss, tok = "https://acme.okta.com/oauth2/default", "https://acme.okta.com/oauth2/default/v1/token"
	bad := map[string]oidc.Settings{
		"http issuer":              okta("http://acme.okta.com/oauth2/default", tok),
		"http token endpoint":      okta(iss, "http://acme.okta.com/oauth2/default/v1/token"),
		"no scheme":                okta("acme.okta.com/oauth2/default", tok),
		"the org server":           okta("https://acme.okta.com", tok),
		"another path":             okta("https://acme.okta.com/api/v1/users", tok),
		"a deeper path":            okta("https://acme.okta.com/oauth2/default/v1", tok),
		"a trailing slash":         okta("https://acme.okta.com/oauth2/default/", tok),
		"a query":                  okta("https://acme.okta.com/oauth2/default?x=1", tok),
		"a query on the token":     okta(iss, tok+"?x=1"),
		"a fragment":               okta("https://acme.okta.com/oauth2/default#x", tok),
		"userinfo":                 okta("https://user:pw@acme.okta.com/oauth2/default", tok),
		"userinfo on the token":    okta(iss, "https://user:pw@acme.okta.com/oauth2/default/v1/token"),
		"a port":                   okta("https://acme.okta.com:8443/oauth2/default", tok),
		"a port on the token":      okta(iss, "https://acme.okta.com:8443/oauth2/default/v1/token"),
		"an IPv4 literal":          okta("https://93.184.216.34/oauth2/default", "https://93.184.216.34/oauth2/default/v1/token"),
		"a loopback literal":       okta("https://127.0.0.1/oauth2/default", "https://127.0.0.1/oauth2/default/v1/token"),
		"a decimal address":        okta("https://2130706433/oauth2/default", "https://2130706433/oauth2/default/v1/token"),
		"a hex-looking name":       okta("https://0x7f.1/oauth2/default", "https://0x7f.1/oauth2/default/v1/token"),
		"a trailing dot":           okta("https://acme.okta.com./oauth2/default", "https://acme.okta.com./oauth2/default/v1/token"),
		"a one-label host":         okta("https://okta/oauth2/default", "https://okta/oauth2/default/v1/token"),
		"a newline":                okta("https://acme.okta.com/oauth2/default\n", tok),
		"an IPv6 literal":          okta("https://[2606:4700::1111]/oauth2/default", "https://[2606:4700::1111]/oauth2/default/v1/token"),
		"an upper-case host":       okta("https://ACME.okta.com/oauth2/default", "https://ACME.okta.com/oauth2/default/v1/token"),
		"an encoded path":          okta("https://acme.okta.com/oauth2/de%66ault", tok),
		"an encoded token path":    okta(iss, "https://acme.okta.com/oauth2/%2e%2e/token"),
		"a dot segment":            okta(iss, "https://acme.okta.com/oauth2/../v1/token"),
		"a double slash":           okta(iss, "https://acme.okta.com//v1/token"),
		"a space in the path":      okta("https://acme.okta.com/oauth2/de fault", tok),
		"no token path":            okta(iss, "https://acme.okta.com"),
		"no token endpoint":        okta(iss, ""),
		"a foreign token host":     okta(iss, "https://evil.example.org/oauth2/default/v1/token"),
		"a sibling token host":     okta(iss, "https://evil.okta.com/oauth2/default/v1/token"),
		"a parent token host":      okta(iss, "https://okta.com/oauth2/default/v1/token"),
		"a longer token host":      okta(iss, "https://acme.okta.com.evil.example/oauth2/default/v1/token"),
		"no client id":             {Preset: oidc.PresetOkta, Issuer: iss, TokenEndpoint: tok},
		"a short okta client id":   {Preset: oidc.PresetOkta, Issuer: iss, TokenEndpoint: tok, ClientID: "0oa123"},
		"a user id":                {Preset: oidc.PresetOkta, Issuer: iss, TokenEndpoint: tok, ClientID: "00u1b2c3d4e5f6g7h8i9"},
		"an okta client id with &": {Preset: oidc.PresetOkta, Issuer: iss, TokenEndpoint: tok, ClientID: "0oa1b2c3d4e5f6g7h&i9"},
		"a client id with a space": {Preset: oidc.PresetGeneric, Issuer: "https://idp.acme.example", TokenEndpoint: "https://idp.acme.example/token", ClientID: "mail client"},
		"a client id too long":     {Preset: oidc.PresetGeneric, Issuer: "https://idp.acme.example", TokenEndpoint: "https://idp.acme.example/token", ClientID: strings.Repeat("a", 257)},
		"an extra the preset lacks": {
			Preset: oidc.PresetKeycloak, Issuer: "https://sso.acme.example/realms/acme",
			TokenEndpoint: "https://sso.acme.example/realms/acme/protocol/openid-connect/token", ClientID: "mail",
			Extra: map[string]string{"realm": "x"},
		},
		"an extra with a newline": {
			Preset: oidc.PresetAuth0, Issuer: "https://acme.auth0.com", TokenEndpoint: "https://acme.auth0.com/oauth/token", ClientID: "mail",
			Extra: map[string]string{"audience": "a\nb"},
		},
		"an empty extra": {
			Preset: oidc.PresetAuth0, Issuer: "https://acme.auth0.com", TokenEndpoint: "https://acme.auth0.com/oauth/token", ClientID: "mail",
			Extra: map[string]string{"audience": ""},
		},
		"an extra with a leading space": {
			Preset: oidc.PresetAuth0, Issuer: "https://acme.auth0.com", TokenEndpoint: "https://acme.auth0.com/oauth/token", ClientID: "mail",
			Extra: map[string]string{"audience": " https://mail"},
		},
		"an extra with a trailing space": {
			Preset: oidc.PresetAuth0, Issuer: "https://acme.auth0.com", TokenEndpoint: "https://acme.auth0.com/oauth/token", ClientID: "mail",
			Extra: map[string]string{"scope": "openid "},
		},
	}
	for name, s := range bad {
		if err := s.Validate(); err == nil {
			t.Errorf("%s was accepted: %+v", name, s)
		}
	}
}

// ── The preset table itself ──────────────────────────────────────────────

// The okta preset is stricter than the generic lane it specialises: an id the
// generic preset takes is not an Okta one.
func TestTheOktaPresetKeepsOktasClientIDRule(t *testing.T) {
	s := oidctest.Okta.Settings()
	s.ClientID = oidctest.Generic.ClientID
	if err := s.Validate(); err == nil {
		t.Error("the okta preset accepted a client id that is not an Okta one")
	}
}

// OneLogin's password grant is documented only with `Authorization: Basic <id>:<secret>`,
// and this lane holds no client secret, so it is not a preset.
func TestOneLoginIsNotAPreset(t *testing.T) {
	for _, name := range oidc.PresetNames() {
		if name == "onelogin" {
			t.Fatal("onelogin is a preset")
		}
	}
	s := oidctest.Generic.Settings()
	s.Preset = "onelogin"
	if err := s.Validate(); err == nil {
		t.Error("onelogin settings were accepted")
	}
}
