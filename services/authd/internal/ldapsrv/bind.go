package ldapsrv

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/directory"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// budgetOpTimeout bounds one budget reserve or release. It is part of the 2s of
// slack DefaultOpTimeout leaves above a verifier's own timeout.
const budgetOpTimeout = time.Second

// handleBind answers Stalwart's two kinds of bind.
//
// The service bind is Stalwart authenticating as itself. It is needed even
// though bindAuthentication is on, because address validation and metadata
// lookups are not performed as any user.
//
// The user bind is the whole point of authd: Stalwart has already located the
// DN via filterLogin and now binds as that user. Whatever answers this bind is
// the authority on the password, and which provider that is - Clerk today - is
// decided per account by the resolver.
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
	// keeps arriving, and this is where the login is refused. It comes before the
	// verifier is chosen and before the credential cache: a password that was
	// right yesterday, cached or asked of the company's directory, must not open
	// a suspended mailbox. Same answer as a wrong password, by design.
	if account.Suspended {
		s.log.Info("bind rejected", "reason", "mailbox_suspended", "uid", uid)
		w.Write(res)
		return
	}

	// ⚠ THE SAME FOR EVERY OTHER REASON THE ROW GIVES FOR TURNING A LOGIN OFF, AND
	// FOR THE SAME REASON: each is read from the row this bind already holds, so it
	// takes effect on both pods at once, and each comes before the verifier and the
	// credential cache so that a password that was right yesterday cannot open it.
	//
	//   - a payment hold: the workspace has no paid plan. Mail still arrives; paying
	//     again clears the column and the next bind works.
	//   - Clerk's ban or lock: neither moves `clerk_updated_at` the way a password
	//     change does, and verify_password may still say yes for the user.
	//   - the domain no longer hosts mail (#406): switched off, lost to another
	//     workspace's proof, or its proof lapsed. A domain-level gate, so it needs no
	//     write to the mailbox and a suspension an admin set by hand is untouched.
	//
	// Same answer as a wrong password, by design.
	if reason := refusedByRow(account); reason != "" {
		s.log.Info("bind rejected", "reason", reason, "uid", uid)
		w.Write(res)
		return
	}

	// Which provider holds this person's password. A resolver that cannot say is
	// not evidence about the password either.
	v, err := s.resolver.Resolve(ctx, account)
	if err != nil || v == nil {
		s.log.Error("bind: verifier resolution failed", "uid", uid, slog.Any("err", err))
		s.respondUnavailable(w, "authentication backend temporarily unavailable")
		return
	}

	// The account, copied: the verification below can outlive this handler (see
	// the flight), and the store may hand out a pointer into its own state.
	acct := *account
	sub := credcache.Subject{
		UserID:    acct.ClerkUserID,
		Verifier:  v.Name(),
		ChangedAt: acct.ClerkUpdatedAt,
		Epoch:     acct.CredentialEpoch,
	}

	// ⚠ THE ORDER FROM HERE IS A SECURITY PROPERTY, AND EACH STEP MUST STAY WHERE
	// IT IS:
	//
	//   projection lookup (above) -> resolve verifier -> cache -> flight ->
	//   identical-failure memory -> per-DN throttle -> budget reserve -> verify ->
	//   release or keep -> cache store
	//
	// THE CACHE COMES AFTER THE ACCOUNT LOOKUP, because the projection is what
	// knows whether the account is still active. A suspended, unpaid or
	// deprovisioned account has already been turned away above, so a hit can only
	// ever skip the PASSWORD check - never the account check. The entry is bound
	// to the verifier name, `clerk_updated_at` and `credential_epoch` read from
	// that same row, so a password change, a revocation or a switch of provider
	// all make it stop matching at no extra query.
	//
	// IT COMES BEFORE EVERYTHING BELOW, because a hit spends no provider call, no
	// throttle token and no failure-budget slot - otherwise Apple Mail opening
	// six connections at once would still be throttled for calls it never makes,
	// and a person whose budget is spent could not read mail they are entitled
	// to. A wrong password still misses the cache and still meets all of it.
	if s.credCache.Lookup(sub, password) {
		s.log.Info("bind succeeded", "uid", uid, "mail", acct.Email, "source", "cache")
		w.Write(ldap.NewBindResponse(ldap.LDAPResultSuccess))
		return
	}

	// ⚠ THE FLIGHT: concurrent identical binds share ONE verification. A mail
	// client opens several connections at once with the same password; the answer
	// cannot differ, so only the first spends a throttle token, a budget slot and
	// a provider call. It is keyed by an HMAC of (account, verifier, password,
	// epoch, updated_at) - never by the raw password - so a different password,
	// a different provider or a changed account is a different flight.
	//
	// The work runs detached from this handler, so a bind that times out leaves
	// the others unaffected, and the slot is still released afterwards. This
	// handler waits only as long as its own operation deadline.
	key := s.flights.Key(acct.ClerkUserID, v.Name(), password,
		strconv.FormatInt(acct.CredentialEpoch, 10), instantKey(acct.ClerkUpdatedAt))
	answer, err := s.flights.Do(ctx, key, func() bindAnswer {
		return s.verifyOnce(v, &acct, sub, dn, password)
	})
	if err != nil {
		// Our own deadline ran out, or the shared work died. Neither is an
		// answer about the password.
		s.log.Error("bind: verification did not complete", "uid", uid, slog.Any("err", err))
		s.respondUnavailable(w, "authentication backend temporarily unavailable")
		return
	}

	resp := ldap.NewBindResponse(answer.code)
	if answer.diag != "" {
		resp.SetDiagnosticMessage(answer.diag)
	}
	w.Write(resp)
}

// refusedByRow names why the account row alone turns this login away, or "".
// Suspension is checked before it, with its own reason, in handleBind.
func refusedByRow(a *projection.Account) string {
	switch {
	case a.PaymentHold:
		return "payment_hold"
	case a.DomainNotHosted:
		return "domain_not_hosted"
	case a.Banned:
		return "account_banned"
	case a.Locked:
		return "account_locked"
	}
	return ""
}

// bindAnswer is what a verification concluded, shared by every bind that
// collapsed into it.
type bindAnswer struct {
	code int
	diag string
}

var (
	answerSuccess = bindAnswer{code: ldap.LDAPResultSuccess}
	answerInvalid = bindAnswer{code: ldap.LDAPResultInvalidCredentials}
)

func answerUnavailable(msg string) bindAnswer {
	return bindAnswer{code: ldap.LDAPResultUnavailable, diag: msg}
}

func answerBusy(msg string) bindAnswer {
	return bindAnswer{code: ldap.LDAPResultBusy, diag: msg}
}

// verifyOnce is everything between "this password missed the cache" and "here is
// the answer". It owns its contexts: it runs on a goroutine of its own and
// outlives the handler that started it.
func (s *Server) verifyOnce(
	v verify.Verifier,
	account *projection.Account,
	sub credcache.Subject,
	dn, password string,
) bindAnswer {
	uid := account.ClerkUserID
	budget := v.Budget()

	if budget != nil {
		if s.budget == nil {
			// A provider that can lock the real account, with nowhere to count.
			// Forwarding anyway is exactly what the budget exists to prevent.
			s.log.Error("bind: budgeted verifier has no budget store", "uid", uid, "verifier", v.Name())
			return answerUnavailable("authentication backend temporarily unavailable")
		}

		// ⚠ IDENTICAL RETRIES NEVER REACH THE PROVIDER OR SPEND A SLOT. A phone
		// retries its stale saved password every few seconds; forwarding each
		// would burn the budget on one mistake. Only for budgeted verifiers: for
		// Clerk a rejection is still never remembered, because there it buys
		// nothing and a corrected password must reach Clerk at once.
		if s.rejections.Seen(sub, password) {
			s.log.Info("bind rejected", "reason", "identical_retry", "uid", uid, "verifier", v.Name())
			return answerInvalid
		}
	}

	if s.limiter != nil && !s.limiter.Allow(dn) {
		// Busy, not unavailable: the service is healthy, this identity is
		// simply over its share. Clients back off on both, but the distinction
		// is what makes the logs diagnosable.
		s.log.Warn("bind throttled", "dn", dn)
		return answerBusy("too many authentication attempts, slow down")
	}

	var (
		slot     verify.Slot
		reserved bool
	)
	if budget != nil {
		// ⚠ RESERVE BEFORE FORWARDING, ATOMICALLY, IN THE STORE SHARED BY EVERY
		// POD. Counting after the answer would let N concurrent binds each see
		// room and all forward. If the store cannot be reached we do not know
		// whether there is room, so we do not forward: failing open here is how a
		// database blip locks the real company account.
		rctx, cancel := context.WithTimeout(context.Background(), budgetOpTimeout)
		var ok bool
		var err error
		slot, ok, err = s.budget.Reserve(rctx, uid, *budget)
		cancel()
		if err != nil {
			s.log.Error("bind: failure budget unreachable, not forwarding", "uid", uid, "verifier", v.Name(), slog.Any("err", err))
			return answerUnavailable("authentication backend temporarily unavailable")
		}
		if !ok {
			s.log.Warn("bind refused", "reason", "failure_budget_spent", "uid", uid, "verifier", v.Name())
			return answerBusy("failed-attempt budget for this account is spent, try again later")
		}
		reserved = true
	}

	// release hands the slot back. A failure to release leaves the slot spent,
	// which is the safe direction: fewer forwards, never more.
	release := func() {
		if !reserved {
			return
		}
		rctx, cancel := context.WithTimeout(context.Background(), budgetOpTimeout)
		defer cancel()
		if err := s.budget.Release(rctx, uid, slot); err != nil {
			s.log.Warn("bind: could not release a failure-budget slot", "uid", uid, slog.Any("err", err))
		}
	}

	timeout := v.Timeout()
	if timeout <= 0 || timeout > verify.MaxTimeout {
		timeout = verify.MaxTimeout
	}
	vctx, cancel := context.WithTimeout(context.Background(), timeout)
	outcome, err := v.Verify(vctx, account, password)
	cancel()

	switch outcome {
	case verify.Verified:
		// A success is not a failure, so it gives its slot back. The window is
		// NOT reset by it: whether Okta resets its own counter on success is
		// unprobed, and until it is, earlier failures stay counted.
		release()

		// ⚠ ONLY THIS BRANCH CACHES. Remembering a rejection would leave a
		// corrected password broken for the rest of the TTL, and would let one
		// failed attempt suppress a real one. Remembering an unavailable answer
		// would be caching the absence of an answer.
		// A provider that never reports a password change caps how long its
		// answer may stand in for asking again (verify.CacheLimit).
		if limit, ok := v.(verify.CacheLimit); ok {
			s.credCache.StoreFor(sub, password, limit.MaxCacheTTL())
		} else {
			s.credCache.Store(sub, password)
		}
		s.log.Info("bind succeeded", "uid", uid, "mail", account.Email, "source", v.Name())
		return answerSuccess

	case verify.Rejected:
		// The slot is KEPT: this failure really reached the provider, and the
		// provider counts it against the person.
		if budget != nil {
			s.rejections.Remember(sub, password, budget.Window)
		}
		s.log.Info("bind rejected", "reason", v.Name()+"_rejected", "uid", uid)
		return answerInvalid

	default:
		// Not a failure the provider counted, so the slot goes back.
		release()

		// ⚠ THE ONE THAT MATTERS. The provider did not answer. Reporting
		// invalidCredentials here would make every mail client in the fleet
		// conclude the stored password is wrong - Apple Mail and Outlook
		// respond by prompting the user, and people start changing passwords
		// to fix an outage that was never theirs. LDAP "unavailable" makes
		// clients back off and retry instead.
		s.log.Error("bind: verifier unavailable", "uid", uid, "verifier", v.Name(), slog.Any("err", err))
		return answerUnavailable("authentication backend temporarily unavailable")
	}
}

func (s *Server) respondUnavailable(w ldap.ResponseWriter, msg string) {
	res := ldap.NewBindResponse(ldap.LDAPResultUnavailable)
	res.SetDiagnosticMessage(msg)
	w.Write(res)
}

// instantKey renders a nullable timestamp for a flight key. Null and any real
// instant must differ, as they do in credcache.
func instantKey(t *time.Time) string {
	if t == nil {
		return "-"
	}
	return strconv.FormatInt(t.UnixNano(), 10)
}
