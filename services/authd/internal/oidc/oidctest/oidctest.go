// Package oidctest is a fake token endpoint for tests, and one fixture per preset
// with the refusals that provider really sends.
//
// It is a real TLS server, so the production client's certificate check, vetted
// dial and form encoding all run. The Okta replies are the ones probed against a
// real org (issue #383, "Okta password lane probed"); the rest are quoted from
// each vendor's documentation, with the source beside them (see presets.go for
// what was and was not confirmed against a live server).
package oidctest

import (
	"context"
	"crypto/x509"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"sync"
	"testing"

	"github.com/i10-tech/i10/services/authd/internal/oidc"
)

// Host is the name the server's certificate is valid for (httptest's). Every
// fixture's issuer and token endpoint are on it.
const Host = "example.com"

// Fixture is one preset's settings, whole.
type Fixture struct {
	Preset        string
	Issuer        string
	TokenEndpoint string
	ClientID      string
	Extra         map[string]string
}

// Settings is the fixture as authd receives it from the API.
func (f Fixture) Settings() oidc.Settings {
	return oidc.Settings{
		Preset: f.Preset, Issuer: f.Issuer, TokenEndpoint: f.TokenEndpoint,
		ClientID: f.ClientID, Extra: f.Extra,
	}
}

// Path is where the fixture's token endpoint is.
func (f Fixture) Path() string {
	u, _ := url.Parse(f.TokenEndpoint)
	return u.Path
}

// One fixture per preset, each shaped the way that provider's discovery document
// shapes it.
var (
	Okta = Fixture{
		Preset: oidc.PresetOkta, Issuer: "https://" + Host + "/oauth2/default",
		TokenEndpoint: "https://" + Host + "/oauth2/default/v1/token", ClientID: "0oa1b2c3d4e5f6g7h8i9",
	}
	Keycloak = Fixture{
		Preset: oidc.PresetKeycloak, Issuer: "https://" + Host + "/realms/acme",
		TokenEndpoint: "https://" + Host + "/realms/acme/protocol/openid-connect/token", ClientID: "mail-client",
	}
	// Auth0's issuer is the bare tenant host (its own ends in a slash, which the API
	// drops) and its token endpoint is /oauth/token.
	Auth0 = Fixture{
		Preset: oidc.PresetAuth0, Issuer: "https://" + Host,
		TokenEndpoint: "https://" + Host + "/oauth/token", ClientID: "Zk3q9XvYw0aB5cD7eF1gH2iJ4kL6mN8o",
		Extra: map[string]string{"audience": "https://mail.acme.test", "realm": "Username-Password-Authentication"},
	}
	Ping = Fixture{
		Preset: oidc.PresetPing, Issuer: "https://" + Host,
		TokenEndpoint: "https://" + Host + "/as/token.oauth2", ClientID: "mail-client",
		Extra: map[string]string{"validator_id": "ldap-pcv"},
	}
	FusionAuth = Fixture{
		Preset: oidc.PresetFusionAuth, Issuer: "https://" + Host,
		TokenEndpoint: "https://" + Host + "/oauth2/token", ClientID: "85a03867-dccf-4882-adde-1a79aeec50df",
	}
	Generic = Fixture{
		Preset: oidc.PresetGeneric, Issuer: "https://" + Host + "/idp",
		TokenEndpoint: "https://" + Host + "/idp/token", ClientID: "mail",
	}
)

// All is every fixture, one per preset.
var All = []Fixture{Okta, Keycloak, Auth0, Ping, FusionAuth, Generic}

// Request is one call the server received.
type Request struct {
	Method      string
	Path        string
	ContentType string
	Header      http.Header
	Form        url.Values
}

// Reply is what the server answers with.
type Reply struct {
	Status int
	Body   string
	Header map[string]string
}

// Granted is what every provider says to a right password.
var Granted = Reply{Status: 200, Body: `{"token_type":"Bearer","expires_in":3600,"access_token":"eyJraWQiOiJ0ZXN0In0.eyJ0ZXN0Ijp0cnVlfQ.c2ln","scope":"openid"}`}

// Replies that need no provider: a setup that is wrong, or an outage.
var (
	InvalidClient = Reply{Status: 401, Body: `{"error":"invalid_client","error_description":"The client secret supplied for a confidential client is invalid."}`}
	RateLimited   = Reply{Status: 429, Body: `{"errorCode":"E0000047","errorSummary":"API call exceeded rate limit due to too many requests."}`}
	Down          = Reply{Status: 503, Body: `Service Unavailable`}
)

// Okta, probed.
var (
	// OktaInvalidCredentials is a wrong password, and also what a LOCKED account says.
	OktaInvalidCredentials = Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"The credentials provided were invalid."}`}
	// OktaMFARequired is the right password on an app whose sign-in policy wants more.
	OktaMFARequired = Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"Resource owner password credentials authentication denied by sign on policy."}`}
)

// Keycloak: https://phasetwo.io/blog/keycloak-invalid-grant/
var (
	// KeycloakInvalidCredentials is a wrong password, an unknown user AND a lockout.
	// The source answers 401; the vendor probe saw 400. The mapping ignores which.
	KeycloakInvalidCredentials = Reply{Status: 401, Body: `{"error":"invalid_grant","error_description":"Invalid user credentials"}`}
	KeycloakDisabled           = Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"Account disabled"}`}
	KeycloakNotSetUp           = Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"Account is not fully set up"}`}
	// KeycloakDirectGrantsOff is a client without Direct Access Grants: our
	// customer's setup, not a refusal of the person.
	KeycloakDirectGrantsOff = Reply{Status: 400, Body: `{"error":"unauthorized_client","error_description":"Client not allowed for direct access grants"}`}
)

// Auth0: https://auth0.com/docs/api/authentication/resource-owner-password-flow/get-token
var (
	Auth0WrongPassword = Reply{Status: 403, Body: `{"error":"invalid_grant","error_description":"Wrong email or password."}`}
	// Auth0MFARequired: 403 mfa_required beside an mfa_token (authenticate-using-ropg-flow-with-mfa).
	Auth0MFARequired = Reply{Status: 403, Body: `{"error":"mfa_required","error_description":"Multifactor authentication required","mfa_token":"Fe26.2**x"}`}
	// Auth0AccountBlocked: brute-force protection blocked the ACCOUNT.
	Auth0AccountBlocked = Reply{Status: 429, Body: `{"error":"too_many_attempts","error_description":"Your account has been blocked after multiple consecutive login attempts. We've sent you a notification via your preferred contact method with instructions on how to unblock it."}`}
	// Auth0Suspicious: the same error code, but about OUR address being throttled.
	Auth0Suspicious  = Reply{Status: 429, Body: `{"error":"too_many_attempts","error_description":"We have detected suspicious login behavior and further attempts will be blocked. Please contact the administrator."}`}
	Auth0UserBlocked = Reply{Status: 403, Body: `{"error":"blocked_user","error_description":"Blocked user"}`}
	// Auth0LegacyBlocked is the legacy /oauth/ro wording.
	Auth0LegacyBlocked = Reply{Status: 401, Body: `{"error":"unauthorized","error_description":"user is blocked"}`}
	Auth0AccessDenied  = Reply{Status: 403, Body: `{"error":"access_denied","error_description":"Wrong email or password."}`}
	// Auth0GrantOff is the application without the Password grant enabled.
	Auth0GrantOff = Reply{Status: 403, Body: `{"error":"unauthorized_client","error_description":"Grant type 'http://auth0.com/oauth/grant-type/password-realm' not allowed for the client."}`}
)

// PingFederate: the description is the password credential validator's own.
// https://docs.pingidentity.com/pingfederate/13.1/developers_reference_guide/pf_oauth_grant_type_param.html
var PingInvalidCredentials = Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"We didn't recognize the username or password you entered. Please try again."}`}

// FusionAuth: https://fusionauth.io/docs/apis/oauth/oauth-error and the forum
// answer for two_factor_required. The `error` that goes with each reason is not
// documented, so the bodies pair them with an `error` the mapping must not need.
var (
	FusionAuthInvalidCredentials = Reply{Status: 400, Body: `{"error":"invalid_request","error_description":"Invalid user credentials.","error_reason":"invalid_user_credentials"}`}
	FusionAuthMFARequired        = Reply{Status: 400, Body: `{"error":"two_factor_required","error_description":"The user has enabled two factor authentication.","two_factor_id":"gDNV2_fFtl7vhMV5_5bFJUL3ZyZ5Ine69n0xWDXKEGw"}`}
	FusionAuthLocked             = Reply{Status: 400, Body: `{"error":"invalid_request","error_description":"The user is locked.","error_reason":"user_locked"}`}
	FusionAuthExpired            = Reply{Status: 400, Body: `{"error":"invalid_request","error_description":"The user is expired.","error_reason":"user_expired"}`}
	FusionAuthChangePassword     = Reply{Status: 400, Body: `{"change_password_id":"a65f7ac3-e4ce-4bf6-bbb0-576189c4d965","error":"change_password_required","error_description":"The user is required to change their password.","error_reason":"change_password_breached"}`}
	// FusionAuthClientAuthRequired is an application that insists on a client
	// secret: our customer's setup.
	FusionAuthClientAuthRequired = Reply{Status: 401, Body: `{"error":"invalid_client","error_description":"Invalid client authentication.","error_reason":"client_authentication_missing"}`}
)

// GenericInvalidGrant is RFC 6749 5.2 and nothing else.
var GenericInvalidGrant = Reply{Status: 400, Body: `{"error":"invalid_grant"}`}

// Server is the fake endpoint.
type Server struct {
	srv *httptest.Server

	mu      sync.Mutex
	handle  func(Request) Reply
	calls   []Request
	trusted *x509.CertPool
}

// Start runs a server that answers Granted until told otherwise.
func Start(t testing.TB) *Server {
	t.Helper()
	s := &Server{handle: func(Request) Reply { return Granted }}
	s.srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		req := Request{
			Method:      r.Method,
			Path:        r.URL.Path,
			ContentType: r.Header.Get("Content-Type"),
			Header:      r.Header.Clone(),
			Form:        r.PostForm,
		}
		s.mu.Lock()
		s.calls = append(s.calls, req)
		handle := s.handle
		s.mu.Unlock()

		reply := handle(req)
		for k, v := range reply.Header {
			w.Header().Set(k, v)
		}
		w.WriteHeader(reply.Status)
		_, _ = w.Write([]byte(reply.Body))
	}))
	t.Cleanup(s.srv.Close)
	s.trusted = x509.NewCertPool()
	s.trusted.AddCert(s.srv.Certificate())
	return s
}

// Respond makes every call answer with r.
func (s *Server) Respond(r Reply) { s.Handle(func(Request) Reply { return r }) }

// Handle decides each reply from the request.
func (s *Server) Handle(fn func(Request) Reply) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handle = fn
}

// Calls is every request received, oldest first.
func (s *Server) Calls() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.calls...)
}

// Count is how many requests were received.
func (s *Server) Count() int { return len(s.Calls()) }

// Addr is where the server listens.
func (s *Server) Addr() string { return s.srv.Listener.Addr().String() }

// PublicResolver resolves every name to a public address, so the egress guard
// passes and the dial hook decides where the connection really goes.
type PublicResolver struct{}

// LookupNetIP implements egress.Resolver.
func (PublicResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

// Client is a production client wired to the server: the guard sees a public
// address for Host, the dial goes to the server, and its certificate is trusted.
func (s *Server) Client() *oidc.Client {
	return &oidc.Client{
		Resolver: PublicResolver{},
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, s.Addr())
		},
		RootCAs: s.trusted,
	}
}
