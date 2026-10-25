package ldapsrv

import (
	"context"
	"log/slog"

	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/clerkauth"
	"github.com/i10-tech/i10/services/authd/internal/directory"
	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// handleBind answers Stalwart's two kinds of bind.
//
// The service bind is Stalwart authenticating as itself. It is needed even
// though bindAuthentication is on, because address validation and metadata
// lookups are not performed as any user.
//
// The user bind is the whole point of authd: Stalwart has already located the
// DN via filterLogin and now binds as that user. Whatever answers this bind is
// the authority on the password, and here that authority is Clerk.
func (s *Server) handleBind(w ldap.ResponseWriter, m *ldap.Message) {
	r := m.GetBindRequest()
	res := ldap.NewBindResponse(ldap.LDAPResultInvalidCredentials)

	if r.AuthenticationChoice() != "simple" {
		res.SetResultCode(ldap.LDAPResultInappropriateAuthentication)
		res.SetDiagnosticMessage("only simple authentication is supported")
		w.Write(res)
		return
	}

	dn := string(r.Name())
	password := string(r.AuthenticationSimple())

	// RFC 4513 §5.1.2: a simple bind with an empty password is an *unauthenticated*
	// bind, and the server must not treat it as verifying the named identity.
	// Forwarding it to Clerk would also mean asking Clerk to verify "" on every
	// anonymous probe.
	if password == "" {
		res.SetDiagnosticMessage("empty password")
		w.Write(res)
		s.log.Info("bind rejected", "reason", "empty_password", "dn", dn)
		return
	}

	if dn == "" {
		res.SetDiagnosticMessage("anonymous bind is not supported")
		w.Write(res)
		return
	}

	if directory.EqualDN(dn, s.serviceBindDN) {
		if s.secretMatches([]byte(password)) {
			w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))
			s.log.Debug("service bind succeeded")
			return
		}
		s.log.Warn("service bind failed: wrong secret")
		w.Write(res)
		return
	}

	ctx, cancel := s.opContext()
	defer cancel()

	uid := directory.UIDFromDN(dn, s.baseDN)
	if uid == "" {
		s.log.Info("bind rejected", "reason", "dn_not_under_people", "dn", dn)
		w.Write(res)
		return
	}

	account, err := s.store.AccountByUID(ctx, uid)
	if err != nil {
		// The projection is unreachable. This is not evidence about the
		// password, so it must not be reported as invalid credentials.
		s.log.Error("bind: projection lookup failed", "dn", dn, "err", err)
		s.respondUnavailable(w, "directory temporarily unavailable")
		return
	}
	if account == nil {
		// No such account, or it is inactive - suspended, unpaid, or
		// deprovisioned. Indistinguishable from a wrong password by design.
		s.log.Info("bind rejected", "reason", "no_active_account", "uid", uid)
		w.Write(res)
		return
	}

	// ⚠ A SUSPENDED MAILBOX CANNOT LOG IN, AND IT STILL RECEIVES (#344). The
	// directory switched the person off; the account is kept active so mail
	// keeps arriving, and this is where the login is refused. It comes before
	// the credential cache and the pass-through: a password that was right
	// yesterday, cached or asked of the company's directory, must not open a
	// suspended mailbox. Same answer as a wrong password, by design.
	if account.Suspended {
		s.log.Info("bind rejected", "reason", "mailbox_suspended", "uid", uid)
		w.Write(res)
		return
	}

	// ⚠ A MANAGED ACCOUNT NEVER REACHES THE CACHE OR CLERK (#344). Its password
	// belongs to the company's directory, so it leaves here: after the account
	// check above (a deactivated account is already refused) and before
	// anything that could answer from, or ask, Clerk.
	if account.Managed {
		s.bindManaged(w, ctx, dn, uid, account, password)
		return
	}

	// ⚠ AFTER THE ACCOUNT LOOKUP, BEFORE THE THROTTLE, AND BOTH HALVES MATTER.
	//
	// After, because the projection is what knows whether the account is still
	// active. A suspended, unpaid or deprovisioned account has already been
	// turned away above, so this can only ever skip the PASSWORD check - never
	// the account check. And it needs `account.ClerkUpdatedAt`, which is the
	// invalidation key: a password change moves it and the entry stops
	// matching.
	//
	// Before, because the limiter exists to protect the Clerk request budget.
	// A cache hit spends no budget, so it should spend no tokens either -
	// otherwise Apple Mail opening six connections at once would still be
	// throttled for calls it never makes. A wrong password still misses the
	// cache and still meets the limiter.
	if s.credCache.Lookup(account.ClerkUserID, password, account.ClerkUpdatedAt) {
		s.log.Info("bind succeeded", "uid", uid, "mail", account.Email, "source", "cache")
		w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))
		return
	}

	if s.throttled(w, dn) {
		return
	}

	outcome, err := s.verifier.Verify(ctx, account.ClerkUserID, password)
	switch outcome {
	case clerkauth.Verified:
		// ⚠ ONLY THIS BRANCH CACHES. Remembering a rejection would leave a
		// corrected password broken for the rest of the TTL, and would let one
		// failed attempt suppress a real one. Remembering an unavailable answer
		// would be caching the absence of an answer.
		s.credCache.Store(account.ClerkUserID, password, account.ClerkUpdatedAt)
		s.log.Info("bind succeeded", "uid", uid, "mail", account.Email, "source", "clerk")
		w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))

	case clerkauth.Rejected:
		s.log.Info("bind rejected", "reason", "clerk_rejected", "uid", uid)
		w.Write(res)

	default:
		// ⚠ THE ONE THAT MATTERS. Clerk did not answer. Reporting
		// invalidCredentials here would make every mail client in the fleet
		// conclude the stored password is wrong - Apple Mail and Outlook
		// respond by prompting the user, and people start changing passwords
		// to fix an outage that was never theirs. LDAP "unavailable" makes
		// clients back off and retry instead.
		s.log.Error("bind: verifier unavailable", "uid", uid, slog.Any("err", err))
		s.respondUnavailable(w, "authentication backend temporarily unavailable")
	}
}

func (s *Server) respondUnavailable(w ldap.ResponseWriter, msg string) {
	res := ldap.NewBindResponse(ldap.LDAPResultUnavailable)
	res.SetDiagnosticMessage(msg)
	w.Write(res)
}

// throttled answers busy and reports true when this identity is over its share.
//
// Busy, not unavailable: the service is healthy, this identity is simply over
// its share. Clients back off on both, but the distinction is what makes the
// logs diagnosable.
func (s *Server) throttled(w ldap.ResponseWriter, dn string) bool {
	if s.limiter == nil || s.limiter.Allow(dn) {
		return false
	}
	s.log.Warn("bind throttled", "dn", dn)
	busy := ldap.NewBindResponse(ldap.LDAPResultBusy)
	busy.SetDiagnosticMessage("too many authentication attempts, slow down")
	w.Write(busy)
	return true
}

// bindManaged answers the bind of an account an SSO connection manages.
//
// ⚠ NOTHING HERE TOUCHES CLERK OR THE CREDENTIAL CACHE, and nothing here may
// ever be changed to fall back to them. A success is never cached either: the
// directory is asked at every bind, so a password the company changed, or a
// person it switched off, stops working at the next bind. (The cost is one
// round trip to the company's directory per IMAP connection; that is the
// price of "one password, theirs".)
//
// The throttle stays: wrong passwords here count against the COMPANY's
// directory's own lockout, so a mail client stuck on a stale password is
// slowed before it locks the person out of their SSO.
//
// The log carries reason codes, never the password, the service secret or a
// DN the directory returned.
func (s *Server) bindManaged(
	w ldap.ResponseWriter,
	ctx context.Context,
	dn, uid string,
	account *projection.Account,
	password string,
) {
	refused := ldap.NewBindResponse(ldap.LDAPResultInvalidCredentials)
	switch {
	case account.ManagedConnection == "":
		// Managed by a connection that is gone. Not an account Clerk may judge.
		s.log.Info("bind rejected", "reason", "managed_no_connection", "uid", uid)
		w.Write(refused)
		return
	case s.passthrough == nil:
		s.log.Info("bind rejected", "reason", "passthrough_not_configured", "uid", uid)
		w.Write(refused)
		return
	}
	if s.throttled(w, dn) {
		return
	}

	result := s.passthrough.Bind(ctx, account.ManagedConnection, account.Email, password)
	switch result.Outcome {
	case passthrough.Verified:
		s.log.Info("bind succeeded", "uid", uid, "mail", account.Email, "source", "passthrough")
		w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))
	case passthrough.Rejected:
		// Includes a connection with no pass-through: IMAP is off for it.
		s.log.Info("bind rejected", "reason", result.Reason, "uid", uid, "source", "passthrough")
		w.Write(refused)
	default:
		// ⚠ The directory, the path to it, or our settings for it did not work.
		// Not evidence about the password, so not invalidCredentials.
		s.log.Error("bind: passthrough unavailable", "reason", result.Reason, "uid", uid)
		s.respondUnavailable(w, "directory temporarily unavailable")
	}
}
