// Package ldapsrv is the LDAP face authd presents to Stalwart.
//
// Only Bind and Search are implemented. Add, Modify, Delete, ModifyDN and
// Compare are deliberately absent: the directory is a read model of Clerk, so
// there is nothing here to write, and every operation that does not exist is
// one that cannot be abused.
//
// That matters more than it sounds. The bytes this package parses are
// attacker-influenced end to end — login strings and passwords arrive from any
// IMAP client on the internet, and recipient addresses arrive from any sending
// MTA via SMTP RCPT TO. Stalwart forwards both into this server.
package ldapsrv

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"time"

	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/clerkauth"
	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/throttle"
)

// Verifier is the password oracle. In production it is *clerkauth.Client.
type Verifier interface {
	Verify(ctx context.Context, userID, password string) (clerkauth.Outcome, error)
}

type Options struct {
	BaseDN            string
	ServiceBindDN     string
	ServiceBindSecret string
	Store             projection.Store
	Verifier          Verifier
	Limiter           *throttle.Limiter
	Logger            *slog.Logger

	// CredCache short-circuits the Clerk call for a password verified in the
	// last TTL. Nil disables it, and a nil *credcache.Cache is safe to call, so
	// the bind path needs no branch of its own.
	CredCache *credcache.Cache

	// OpTimeout bounds the work behind a single LDAP operation — the projection
	// query, and for a bind the Clerk call as well.
	OpTimeout time.Duration
}

type Server struct {
	baseDN            string
	serviceBindDN     string
	serviceBindSecret []byte
	store             projection.Store
	verifier          Verifier
	limiter           *throttle.Limiter
	credCache         *credcache.Cache
	log               *slog.Logger
	opTimeout         time.Duration
}

func New(opts Options) *Server {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	timeout := opts.OpTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Server{
		baseDN:            opts.BaseDN,
		serviceBindDN:     opts.ServiceBindDN,
		serviceBindSecret: []byte(opts.ServiceBindSecret),
		store:             opts.Store,
		verifier:          opts.Verifier,
		limiter:           opts.Limiter,
		credCache:         opts.CredCache,
		log:               log,
		opTimeout:         timeout,
	}
}

// Routes builds the mux. Anything unrouted lands on handleNotFound.
func (s *Server) Routes() *ldap.RouteMux {
	routes := ldap.NewRouteMux()
	routes.NotFound(s.handleNotFound)
	routes.Bind(s.handleBind)
	routes.Search(s.handleSearch)
	return routes
}

func (s *Server) handleNotFound(w ldap.ResponseWriter, m *ldap.Message) {
	// A bind that reaches here means an authentication choice we do not
	// implement. It must fail closed — the default route in the library's own
	// example answers Success, which would be a total authentication bypass.
	if m.ProtocolOpType() == ldap.ApplicationBindRequest {
		res := ldap.NewBindResponse(ldap.LDAPResultInappropriateAuthentication)
		res.SetDiagnosticMessage("only simple authentication is supported")
		w.Write(res)
		return
	}
	res := ldap.NewResponse(ldap.LDAPResultUnwillingToPerform)
	res.SetDiagnosticMessage("operation not supported")
	w.Write(res)
}

// opContext bounds one operation.
//
// It is deliberately NOT wired to m.Done. Despite its doc comment saying it
// closes the channel, Abandon does `m.Done <- true` — an unbuffered send, so
// exactly one receiver gets it. A context goroutine selecting on m.Done would
// race the handler's own check and swallow the signal. Handlers read m.Done
// directly, exactly once; cancellation of the backend work is by timeout.
func (s *Server) opContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), s.opTimeout)
}

// secretMatches compares the service-account secret in constant time.
func (s *Server) secretMatches(candidate []byte) bool {
	return subtle.ConstantTimeCompare(s.serviceBindSecret, candidate) == 1
}
