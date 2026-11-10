package ldapsrv_test

import (
	"fmt"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// The ways a login is turned off by the account row alone. Each is read from the
// row the bind already holds, so each must beat a warm credential cache: a
// password verified an hour ago, cached for two, must not open a mailbox the
// workspace has since lost the right to. Closing them is the point of
// apps/api/src/mailboxes/revoke.ts, and these pin the half that lives here.

// ⚠ THE CACHE WAS PRIMED FIRST, AND THAT IS THE TEST. A refusal checked against a
// cold cache proves nothing: it would pass even if the gate sat after the cache.
func TestEveryRowGateBeatsAWarmCache(t *testing.T) {
	gates := map[string]func(a *projection.Account, on bool){
		"suspended":    func(a *projection.Account, on bool) { a.Suspended = on },
		"payment hold": func(a *projection.Account, on bool) { a.PaymentHold = on },
		"clerk ban":    func(a *projection.Account, on bool) { a.Banned = on },
		"clerk lock":   func(a *projection.Account, on bool) { a.Locked = on },
		// #406: the workspace stopped hosting mail on the domain. Nothing is
		// written to the mailbox for it, so this is the only thing that closes it.
		"domain not hosted": func(a *projection.Account, on bool) { a.DomainNotHosted = on },
	}
	for name, set := range gates {
		t.Run(name, func(t *testing.T) {
			store := defaultStore()
			v := &fakeVerifier{outcome: verify.Verified}
			addr := newFixtureWith(t, store, v, 600, credcache.New(2*time.Hour))

			if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
				t.Fatalf("priming bind: %v", err)
			}
			if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
				t.Fatalf("cached bind: %v", err)
			}
			if v.callCount() != 1 {
				t.Fatalf("verifier called %d times, want 1: the cache was not warm", v.callCount())
			}

			set(&store.accounts[0], true)
			if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultInvalidCredentials {
				t.Fatalf("result = %d, want invalidCredentials while the gate is on", got)
			}
			if v.callCount() != 1 {
				t.Fatalf("verifier called %d times, want 1: a gated account reached the provider", v.callCount())
			}

			// The mailbox keeps receiving: only the login is refused.
			f := fmt.Sprintf(filterMailbox, aliceEmail, aliceEmail, aliceEmail, aliceEmail)
			if got := search(t, addr, f); len(got) != 1 || got[0].DN != aliceDN {
				t.Fatalf("a gated account stopped resolving as a recipient: %v", got)
			}

			// Lifting the gate restores the login with no new provider call: the
			// entry never went anywhere, it was only not consulted.
			set(&store.accounts[0], false)
			if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
				t.Fatalf("bind after lifting the gate: %v", err)
			}
		})
	}
}

// ⚠ A COVERED ACCOUNT THAT IS NOT MANAGED YET MAY NOT USE ITS CLERK PASSWORD.
// Turning "required" on has to bite on the next bind, so the password is cached
// first; turning it off has to restore the login, which the same entry proves.
func TestSSORequiredRefusesAnUnmanagedAccountsClerkPassword(t *testing.T) {
	store := defaultStore()
	clerk := &fakeVerifier{outcome: verify.Verified}
	dir := &fakeDirectory{result: resultVerified}
	addr, _ := managedFixture(t, store, clerk, dir, credcache.New(2*time.Hour))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("priming bind: %v", err)
	}
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("cached bind: %v", err)
	}
	if clerk.callCount() != 1 {
		t.Fatalf("clerk called %d times, want 1: the cache was not warm", clerk.callCount())
	}

	store.accounts[0].SSORequired = true
	if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials once SSO is required", got)
	}
	if clerk.callCount() != 1 || dir.callCount() != 0 {
		t.Fatalf("clerk called %d, directory %d: a required-SSO account was asked of a provider",
			clerk.callCount(), dir.callCount())
	}

	// "Required" turned off again: the Clerk password works as it did.
	store.accounts[0].SSORequired = false
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("bind after SSO stopped being required: %v", err)
	}
}

// A managed account is answered by its company's directory whatever the domain
// requires: that is where SSO leads, and refusing it would lock out the people
// who did exactly what "required" asks.
func TestSSORequiredDoesNotRefuseAManagedAccount(t *testing.T) {
	store := managedStore()
	store.accounts[len(store.accounts)-1].SSORequired = true
	clerk := &fakeVerifier{outcome: verify.Verified}
	dir := &fakeDirectory{result: resultVerified}
	addr, _ := managedFixture(t, store, clerk, dir, nil)

	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("result = %d, want success from the directory", got)
	}
	if dir.callCount() != 1 || clerk.callCount() != 0 {
		t.Fatalf("directory called %d, clerk %d: want 1 and 0", dir.callCount(), clerk.callCount())
	}
}
