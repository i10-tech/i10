// Package oktatest is a fake Okta token endpoint for tests.
//
// It is a real TLS server, so the production client's certificate check, vetted
// dial and form encoding all run. The replies are the ones probed against a real
// org (issue #383, "Okta password lane probed").
package oktatest

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

	"github.com/i10-tech/i10/services/authd/internal/okta"
)

const (
	// Host is the name the server's certificate is valid for (httptest's).
	Host = "example.com"
	// Issuer is an issuer on that host.
	Issuer = "https://" + Host + "/oauth2/default"
	// ClientID is a well-formed Okta client id.
	ClientID = "0oa1b2c3d4e5f6g7h8i9"
)

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

// Replies as Okta really sends them.
var (
	Granted = Reply{Status: 200, Body: `{"token_type":"Bearer","expires_in":3600,"access_token":"eyJraWQiOiJ0ZXN0In0.eyJ0ZXN0Ijp0cnVlfQ.c2ln","scope":"openid"}`}
	// InvalidCredentials is a wrong password, and also what a LOCKED account says.
	InvalidCredentials = Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"The credentials provided were invalid."}`}
	// MFARequired is the right password on an app whose sign-in policy wants more.
	MFARequired   = Reply{Status: 400, Body: `{"error":"invalid_grant","error_description":"Resource owner password credentials authentication denied by sign on policy."}`}
	InvalidClient = Reply{Status: 401, Body: `{"error":"invalid_client","error_description":"The client secret supplied for a confidential client is invalid."}`}
	RateLimited   = Reply{Status: 429, Body: `{"errorCode":"E0000047","errorSummary":"API call exceeded rate limit due to too many requests."}`}
	Down          = Reply{Status: 503, Body: `Service Unavailable`}
)

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

// Settings are settings that point at the server.
func (s *Server) Settings() okta.Settings {
	return okta.Settings{Issuer: Issuer, ClientID: ClientID}
}

// PublicResolver resolves every name to a public address, so the egress guard
// passes and the dial hook decides where the connection really goes.
type PublicResolver struct{}

// LookupNetIP implements egress.Resolver.
func (PublicResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

// Client is a production client wired to the server: the guard sees a public
// address for Host, the dial goes to the server, and its certificate is trusted.
func (s *Server) Client() *okta.Client {
	return &okta.Client{
		Resolver: PublicResolver{},
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, s.Addr())
		},
		RootCAs: s.trusted,
	}
}
