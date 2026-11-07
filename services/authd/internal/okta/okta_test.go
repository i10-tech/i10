package okta_test

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

	"github.com/i10-tech/i10/services/authd/internal/okta"
	"github.com/i10-tech/i10/services/authd/internal/okta/oktatest"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

const (
	email    = "carol@acme.test"
	password = "c4rol-s3cret"
)

func check(t *testing.T, s *oktatest.Server) okta.Result {
	t.Helper()
	return s.Client().Verify(context.Background(), s.Settings(), email, password)
}

// ── The mapping table, one row at a time ─────────────────────────────────

func TestEveryAnswerMapsToTheTriState(t *testing.T) {
	for name, tc := range map[string]struct {
		reply  oktatest.Reply
		want   verify.Outcome
		reason string
	}{
		"a token": {oktatest.Granted, verify.Verified, okta.ReasonVerified},

		// invalid_grant is about the person's credentials, so it is a rejection
		// (and keeps its budget slot) whatever it says.
		"a wrong password, or a locked account": {oktatest.InvalidCredentials, verify.Rejected, okta.ReasonInvalidCredentials},
		"the app still wants a second factor":   {oktatest.MFARequired, verify.Rejected, okta.ReasonMFARequired},
		"an invalid_grant it has no words for": {
			oktatest.Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"The user is not assigned to the client application."}`},
			verify.Rejected, okta.ReasonInvalidCredentials,
		},

		// Our customer's setup. Never the person's password.
		"invalid_client":     {oktatest.InvalidClient, verify.Unavailable, "okta_config_invalid_client"},
		"invalid_client 400": {oktatest.Reply{Status: 400, Body: `{"error":"invalid_client"}`}, verify.Unavailable, "okta_config_invalid_client"},
		"unauthorized_client": {
			oktatest.Reply{Status: 400, Body: `{"error":"unauthorized_client","error_description":"The client is not authorized to use the provided grant type."}`},
			verify.Unavailable, "okta_config_unauthorized_client",
		},
		"unsupported_grant_type": {
			oktatest.Reply{Status: 400, Body: `{"error":"unsupported_grant_type"}`},
			verify.Unavailable, "okta_config_unsupported_grant_type",
		},
		"invalid_scope":          {oktatest.Reply{Status: 400, Body: `{"error":"invalid_scope"}`}, verify.Unavailable, "okta_config_invalid_scope"},
		"a 403":                  {oktatest.Reply{Status: 403, Body: `{"errorCode":"E0000006"}`}, verify.Unavailable, "okta_config_unknown"},
		"a 404 page":             {oktatest.Reply{Status: 404, Body: `<html>not found</html>`}, verify.Unavailable, "okta_config_unknown"},
		"a 400 that is not JSON": {oktatest.Reply{Status: 400, Body: `nope`}, verify.Unavailable, "okta_config_unknown"},
		// Text of the org's choosing never reaches a log line.
		"a hostile error code": {
			oktatest.Reply{Status: 400, Body: `{"error":"x\nlevel=ERROR msg=pwned"}`},
			verify.Unavailable, "okta_config_unknown",
		},

		"rate limited": {oktatest.RateLimited, verify.Unavailable, okta.ReasonRateLimited},
		"a 500":        {oktatest.Reply{Status: 500}, verify.Unavailable, okta.ReasonServerError},
		"a 502":        {oktatest.Reply{Status: 502, Body: "bad gateway"}, verify.Unavailable, okta.ReasonServerError},
		"down":         {oktatest.Down, verify.Unavailable, okta.ReasonServerError},

		// A 200 is a yes only with a token in it.
		"a 200 with no token":     {oktatest.Reply{Status: 200, Body: `{"token_type":"Bearer"}`}, verify.Unavailable, okta.ReasonBadResponse},
		"a 200 that is not JSON":  {oktatest.Reply{Status: 200, Body: `OK`}, verify.Unavailable, okta.ReasonBadResponse},
		"a 200 with an empty one": {oktatest.Reply{Status: 200, Body: `{"access_token":""}`}, verify.Unavailable, okta.ReasonBadResponse},
	} {
		t.Run(name, func(t *testing.T) {
			s := oktatest.Start(t)
			s.Respond(tc.reply)
			got := check(t, s)
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
// Okta says is copied into the reason.
func TestNothingOktaSaysIsCopiedIntoTheReason(t *testing.T) {
	s := oktatest.Start(t)
	s.Respond(oktatest.Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"bad password ` + password + ` for ` + email + `"}`})
	got := check(t, s)
	if got.Outcome != verify.Rejected || strings.Contains(got.Reason, password) || strings.Contains(got.Reason, email) {
		t.Fatalf("got (%v, %q)", got.Outcome, got.Reason)
	}
}

// ── What is sent ─────────────────────────────────────────────────────────

func TestTheRequestIsTheProbedPasswordGrant(t *testing.T) {
	s := oktatest.Start(t)
	// Characters that break a hand-built form body.
	tricky := `p&ss=w rd+%26"é`
	got := s.Client().Verify(context.Background(), s.Settings(), email, tricky)
	if got.Outcome != verify.Verified {
		t.Fatalf("got %+v", got)
	}
	calls := s.Calls()
	if len(calls) != 1 {
		t.Fatalf("%d requests, want 1", len(calls))
	}
	r := calls[0]
	if r.Method != http.MethodPost || r.Path != "/oauth2/default/v1/token" {
		t.Errorf("sent %s %s", r.Method, r.Path)
	}
	if r.ContentType != "application/x-www-form-urlencoded" {
		t.Errorf("content type %q", r.ContentType)
	}
	want := map[string]string{
		"grant_type": "password",
		"username":   email,
		"password":   tricky,
		"scope":      "openid",
		"client_id":  oktatest.ClientID,
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
	if r.Header.Get("Authorization") != "" || r.Form.Has("client_secret") {
		t.Error("the request carries a client credential")
	}
	if r.Header.Get("User-Agent") != okta.UserAgent {
		t.Errorf("User-Agent = %q", r.Header.Get("User-Agent"))
	}
}

func TestAnEmptyPasswordIsRefusedWithoutARequest(t *testing.T) {
	s := oktatest.Start(t)
	got := s.Client().Verify(context.Background(), s.Settings(), email, "")
	if got.Outcome != verify.Rejected || got.Reason != okta.ReasonEmptyPassword || s.Count() != 0 {
		t.Fatalf("got %+v after %d requests", got, s.Count())
	}
}

func TestBadSettingsAreUnavailableWithoutARequest(t *testing.T) {
	s := oktatest.Start(t)
	got := s.Client().Verify(context.Background(), okta.Settings{Issuer: "http://example.com/oauth2/default", ClientID: oktatest.ClientID}, email, password)
	if got.Outcome != verify.Unavailable || got.Reason != okta.ReasonBadSettings || s.Count() != 0 {
		t.Fatalf("got %+v after %d requests", got, s.Count())
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

// ⚠ AN ISSUER IS A CUSTOMER'S CHOICE. One that resolves anywhere non-public is
// never connected to, and nothing is sent.
func TestAnIssuerThatResolvesAnywherePrivateIsNeverDialled(t *testing.T) {
	for name, addrs := range map[string][]netip.Addr{
		"loopback":     {netip.MustParseAddr("127.0.0.1")},
		"metadata":     {netip.MustParseAddr("169.254.169.254")},
		"private":      {netip.MustParseAddr("10.1.2.3")},
		"unique-local": {netip.MustParseAddr("fd00::1")},
		"mixed":        {netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("192.168.0.9")},
	} {
		t.Run(name, func(t *testing.T) {
			s := oktatest.Start(t)
			var dials atomic.Int32
			c := s.Client()
			c.Resolver = answers{oktatest.Host: addrs}
			c.Dial = func(context.Context, string, string) (net.Conn, error) {
				dials.Add(1)
				return nil, errors.New("must not be dialled")
			}
			got := c.Verify(context.Background(), s.Settings(), email, password)
			if got.Outcome != verify.Unavailable || got.Reason != okta.ReasonHostBlocked {
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
	s := oktatest.Start(t)
	var dialled string
	c := s.Client()
	inner := c.Dial
	c.Dial = func(ctx context.Context, network, address string) (net.Conn, error) {
		dialled = address
		return inner(ctx, network, address)
	}
	if got := c.Verify(context.Background(), s.Settings(), email, password); got.Outcome != verify.Verified {
		t.Fatalf("got %+v", got)
	}
	if dialled != "93.184.216.34:443" {
		t.Errorf("dialled %q, want the vetted address on 443", dialled)
	}
}

func TestEveryTransportFailureIsUnavailableWithItsOwnReason(t *testing.T) {
	t.Run("dns", func(t *testing.T) {
		s := oktatest.Start(t)
		c := s.Client()
		c.Resolver = failingResolver{}
		if got := c.Verify(context.Background(), s.Settings(), email, password); got.Outcome != verify.Unavailable || got.Reason != okta.ReasonDNSFailed {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("dial", func(t *testing.T) {
		s := oktatest.Start(t)
		c := s.Client()
		c.Dial = func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("refused") }
		if got := c.Verify(context.Background(), s.Settings(), email, password); got.Outcome != verify.Unavailable || got.Reason != okta.ReasonDialFailed {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("a certificate nobody trusts", func(t *testing.T) {
		s := oktatest.Start(t)
		c := s.Client()
		c.RootCAs = nil
		got := c.Verify(context.Background(), s.Settings(), email, password)
		if got.Outcome != verify.Unavailable || got.Reason != okta.ReasonTLSFailed {
			t.Fatalf("got %+v", got)
		}
		if s.Count() != 0 {
			t.Error("a request was sent over an unverified connection")
		}
	})
	t.Run("a deadline", func(t *testing.T) {
		s := oktatest.Start(t)
		s.Handle(func(oktatest.Request) oktatest.Reply {
			time.Sleep(400 * time.Millisecond)
			return oktatest.Granted
		})
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		got := s.Client().Verify(ctx, s.Settings(), email, password)
		if got.Outcome != verify.Unavailable || got.Reason != okta.ReasonTimeout {
			t.Fatalf("got %+v", got)
		}
	})
}

// ⚠ A REDIRECT WOULD CARRY THE PASSWORD SOMEWHERE NOBODY CONFIGURED. It is the
// answer, and the Location is never requested.
func TestARedirectIsNeverFollowed(t *testing.T) {
	elsewhere := oktatest.Start(t)
	s := oktatest.Start(t)
	s.Respond(oktatest.Reply{Status: 307, Header: map[string]string{"Location": "https://" + elsewhere.Addr() + "/steal"}})
	got := check(t, s)
	if got.Outcome != verify.Unavailable || got.Reason != okta.ReasonRedirected {
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
	s := oktatest.Start(t)
	if got := check(t, s); got.Outcome != verify.Verified {
		t.Fatalf("got %+v", got)
	}
}

// The answer is read up to a bound. A token past it is not a token.
func TestTheAnswerIsReadUpToABound(t *testing.T) {
	s := oktatest.Start(t)
	s.Respond(oktatest.Reply{Status: 200, Body: `{"padding":"` + strings.Repeat("A", 1<<20) + `","access_token":"late"}`})
	got := check(t, s)
	if got.Outcome != verify.Unavailable || got.Reason != okta.ReasonBadResponse {
		t.Fatalf("got %+v", got)
	}
}

// ── Settings ─────────────────────────────────────────────────────────────

func TestSettingsValidate(t *testing.T) {
	const id = "0oa1b2c3d4e5f6g7h8i9"
	good := []okta.Settings{
		{Issuer: "https://acme.okta.com/oauth2/default", ClientID: id},
		{Issuer: "https://acme.oktapreview.com/oauth2/aus1b2c3d4e5f6g7h8i9", ClientID: id},
		{Issuer: "https://id.acme.example/oauth2/default", ClientID: id},
	}
	for _, s := range good {
		if err := s.Validate(); err != nil {
			t.Errorf("%+v refused: %v", s, err)
		}
	}

	bad := map[string]okta.Settings{
		"http":                {Issuer: "http://acme.okta.com/oauth2/default", ClientID: id},
		"no scheme":           {Issuer: "acme.okta.com/oauth2/default", ClientID: id},
		"the org server":      {Issuer: "https://acme.okta.com", ClientID: id},
		"root path":           {Issuer: "https://acme.okta.com/", ClientID: id},
		"a trailing slash":    {Issuer: "https://acme.okta.com/oauth2/default/", ClientID: id},
		"another path":        {Issuer: "https://acme.okta.com/api/v1/users", ClientID: id},
		"a deeper path":       {Issuer: "https://acme.okta.com/oauth2/default/v1", ClientID: id},
		"a query":             {Issuer: "https://acme.okta.com/oauth2/default?x=1", ClientID: id},
		"a fragment":          {Issuer: "https://acme.okta.com/oauth2/default#x", ClientID: id},
		"userinfo":            {Issuer: "https://user:pw@acme.okta.com/oauth2/default", ClientID: id},
		"a port":              {Issuer: "https://acme.okta.com:8443/oauth2/default", ClientID: id},
		"an IPv4 literal":     {Issuer: "https://93.184.216.34/oauth2/default", ClientID: id},
		"a loopback literal":  {Issuer: "https://127.0.0.1/oauth2/default", ClientID: id},
		"a decimal address":   {Issuer: "https://2130706433/oauth2/default", ClientID: id},
		"a hex-looking name":  {Issuer: "https://0x7f.1/oauth2/default", ClientID: id},
		"a trailing dot":      {Issuer: "https://acme.okta.com./oauth2/default", ClientID: id},
		"a one-label host":    {Issuer: "https://okta/oauth2/default", ClientID: id},
		"a newline":           {Issuer: "https://acme.okta.com/oauth2/default\n", ClientID: id},
		"an IPv6 literal":     {Issuer: "https://[2606:4700::1111]/oauth2/default", ClientID: id},
		"a bare host":         {Issuer: "https://localhost/oauth2/default", ClientID: id},
		"an upper-case host":  {Issuer: "https://ACME.okta.com/oauth2/default", ClientID: id},
		"an encoded path":     {Issuer: "https://acme.okta.com/oauth2/de%66ault", ClientID: id},
		"a space in the path": {Issuer: "https://acme.okta.com/oauth2/de fault", ClientID: id},
		"no client id":        {Issuer: "https://acme.okta.com/oauth2/default"},
		"a short client id":   {Issuer: "https://acme.okta.com/oauth2/default", ClientID: "0oa123"},
		"a user id":           {Issuer: "https://acme.okta.com/oauth2/default", ClientID: "00u1b2c3d4e5f6g7h8i9"},
		"a client id with &":  {Issuer: "https://acme.okta.com/oauth2/default", ClientID: "0oa1b2c3d4e5f6g7h&i9"},
	}
	for name, s := range bad {
		if err := s.Validate(); err == nil {
			t.Errorf("%s was accepted: %+v", name, s)
		}
	}
}
