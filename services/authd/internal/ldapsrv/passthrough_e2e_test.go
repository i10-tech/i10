package ldapsrv_test

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/clerkauth"
	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/passthrough/ldaptest"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// A managed account's password belongs to its company (#344). These pin the
// property that matters: such an account is never sent to Clerk, never served
// from the credential cache, and an outage on the way to the company's
// directory is "unavailable" - not "wrong password", and not a question for
// Clerk.

const (
	carolDN   = "uid=user_carol,ou=people,dc=i10,dc=tech"
	carolMail = "carol@acme.test"
	carolPass = "carol-company-password"
	connAcme  = "33333333-3333-4333-8333-333333333333"
)

func managedStore() *fakeStore {
	store := defaultStore()
	store.accounts = append(store.accounts, projection.Account{
		ClerkUserID:       "user_carol",
		Email:             carolMail,
		Active:            true,
		Managed:           true,
		ManagedConnection: connAcme,
	})
	return store
}

type fakePassThrough struct {
	result passthrough.Result
	calls  int
	conn   string
	email  string
}

func (f *fakePassThrough) Bind(_ context.Context, conn, email, _ string) passthrough.Result {
	f.calls++
	f.conn, f.email = conn, email
	return f.result
}

// failing is an API that cannot be reached.
type failing struct{ err error }

func (f failing) Fetch(context.Context, string) (*passthrough.Settings, error) { return nil, f.err }

type fixedSource struct{ s *passthrough.Settings }

func (f fixedSource) Fetch(context.Context, string) (*passthrough.Settings, error) { return f.s, nil }

func code(err error) uint16 { return resultCode(err) }

// ── Refusals first ───────────────────────────────────────────────────────

func TestAManagedAccountNeverReachesClerk(t *testing.T) {
	for name, pt := range map[string]*fakePassThrough{
		"rejected":    {result: passthrough.Result{Outcome: passthrough.Rejected, Reason: "user_bind_rejected"}},
		"unavailable": {result: passthrough.Result{Outcome: passthrough.Unavailable, Reason: "dial_failed"}},
		"verified":    {result: passthrough.Result{Outcome: passthrough.Verified, Reason: "verified"}},
	} {
		t.Run(name, func(t *testing.T) {
			// Clerk would say yes to anything. If it is ever asked, this fails.
			v := &fakeVerifier{outcome: clerkauth.Verified}
			addr := newFixtureFull(t, managedStore(), v, 60, credcache.New(time.Minute), pt)
			_ = dial(t, addr).Bind(carolDN, carolPass)
			if v.calls != 0 {
				t.Fatalf("Clerk was asked %d times about a managed account", v.calls)
			}
			if pt.calls != 1 || pt.conn != connAcme || pt.email != carolMail {
				t.Fatalf("pass-through saw %d calls, connection %q, address %q", pt.calls, pt.conn, pt.email)
			}
		})
	}
}

func TestAManagedAccountIsNeverServedFromTheCredentialCache(t *testing.T) {
	store := managedStore()
	v := &fakeVerifier{outcome: clerkauth.Verified}
	cache := credcache.New(time.Minute)
	pt := &fakePassThrough{result: passthrough.Result{Outcome: passthrough.Rejected, Reason: "user_bind_rejected"}}
	addr := newFixtureFull(t, store, v, 60, cache, pt)

	// The same Clerk user verified (and cached) while it was not managed...
	store.accounts[2].Managed = false
	if err := dial(t, addr).Bind(carolDN, carolPass); err != nil {
		t.Fatalf("unmanaged bind: %v", err)
	}
	if v.calls != 1 {
		t.Fatalf("verifier called %d times, want 1", v.calls)
	}
	// ...and then the company takes the account over. The warm entry must not
	// answer for it.
	store.accounts[2].Managed = true
	if got := code(dial(t, addr).Bind(carolDN, carolPass)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials: a managed account was served from the cache", got)
	}
	if pt.calls != 1 || v.calls != 1 {
		t.Fatalf("pass-through %d calls, Clerk %d calls; want 1 and 1", pt.calls, v.calls)
	}
}

func TestAManagedAccountWithoutPassThroughIsRefused(t *testing.T) {
	cases := map[string]struct {
		pt   ldapsrvPassThrough
		conn string
	}{
		"the connection has it off": {pt: passthrough.NewService(fixedSource{nil}, &passthrough.Binder{}), conn: connAcme},
		"no pass-through at all":    {pt: nil, conn: connAcme},
		"the connection is gone":    {pt: &fakePassThrough{result: passthrough.Result{Outcome: passthrough.Verified}}, conn: ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			store := managedStore()
			store.accounts[2].ManagedConnection = tc.conn
			v := &fakeVerifier{outcome: clerkauth.Verified}
			addr := newFixtureFull(t, store, v, 60, credcache.New(time.Minute), tc.pt)
			if got := code(dial(t, addr).Bind(carolDN, carolPass)); got != goldapclient.LDAPResultInvalidCredentials {
				t.Fatalf("result = %d, want invalidCredentials", got)
			}
			if v.calls != 0 {
				t.Fatalf("Clerk was asked %d times", v.calls)
			}
			if f, ok := tc.pt.(*fakePassThrough); ok && f.calls != 0 {
				t.Fatalf("pass-through was called for an account with no connection")
			}
		})
	}
}

func TestAnUnreachableAPIIsUnavailableNeverAFallbackToClerk(t *testing.T) {
	store := managedStore()
	v := &fakeVerifier{outcome: clerkauth.Verified}
	svc := passthrough.NewService(failing{errors.New("api down")}, &passthrough.Binder{})
	addr := newFixtureFull(t, store, v, 60, nil, svc)

	if got := code(dial(t, addr).Bind(carolDN, carolPass)); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52)", got)
	}
	if v.calls != 0 {
		t.Fatalf("Clerk was asked %d times while the API was down", v.calls)
	}

	// Unmanaged accounts keep working exactly as before, API down or not.
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("an unmanaged account could not bind while the API was down: %v", err)
	}
	if v.calls != 1 {
		t.Fatalf("Clerk called %d times for the unmanaged bind, want 1", v.calls)
	}
}

func TestADeactivatedManagedAccountIsRefusedWithoutAskingAnyone(t *testing.T) {
	store := managedStore()
	store.accounts[2].Active = false
	v := &fakeVerifier{outcome: clerkauth.Verified}
	pt := &fakePassThrough{result: passthrough.Result{Outcome: passthrough.Verified}}
	addr := newFixtureFull(t, store, v, 60, nil, pt)
	if got := code(dial(t, addr).Bind(carolDN, carolPass)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if pt.calls != 0 || v.calls != 0 {
		t.Fatalf("pass-through %d calls, Clerk %d calls; want none", pt.calls, v.calls)
	}
}

func TestAnEmptyPasswordForAManagedAccountReachesNothing(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	pt := &fakePassThrough{result: passthrough.Result{Outcome: passthrough.Verified}}
	addr := newFixtureFull(t, managedStore(), v, 60, nil, pt)
	// The client library refuses to send an empty password; this sends one.
	if got := code(dial(t, addr).UnauthenticatedBind(carolDN)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if pt.calls != 0 || v.calls != 0 {
		t.Fatalf("pass-through %d calls, Clerk %d calls; want none", pt.calls, v.calls)
	}
}

func TestTheThrottleStillGuardsManagedBinds(t *testing.T) {
	pt := &fakePassThrough{result: passthrough.Result{Outcome: passthrough.Rejected, Reason: "user_bind_rejected"}}
	addr := newFixtureFull(t, managedStore(), &fakeVerifier{}, 1, nil, pt) // burst of 1
	_ = dial(t, addr).Bind(carolDN, "wrong")
	if got := code(dial(t, addr).Bind(carolDN, "wrong")); got != goldapclient.LDAPResultBusy {
		t.Fatalf("second bind = %d, want busy (51)", got)
	}
	if pt.calls != 1 {
		t.Fatalf("the company's directory was asked %d times, want 1", pt.calls)
	}
}

func TestAPassThroughSuccessIsNotCached(t *testing.T) {
	pt := &fakePassThrough{result: passthrough.Result{Outcome: passthrough.Verified, Reason: "verified"}}
	addr := newFixtureFull(t, managedStore(), &fakeVerifier{}, 60, credcache.New(time.Minute), pt)
	for i := 0; i < 3; i++ {
		if err := dial(t, addr).Bind(carolDN, carolPass); err != nil {
			t.Fatalf("bind %d: %v", i, err)
		}
	}
	if pt.calls != 3 {
		t.Fatalf("the directory was asked %d times for 3 binds: a success was cached", pt.calls)
	}
}

// ── Against a real directory, end to end ─────────────────────────────────

type ldapsrvPassThrough = interface {
	Bind(ctx context.Context, connectionID, email, password string) passthrough.Result
}

func directoryService(t *testing.T, dir *ldaptest.Server, mutate func(*passthrough.Settings)) ldapsrvPassThrough {
	t.Helper()
	s := passthrough.Settings{
		Host: ldaptest.Host, Port: 636, TLSMode: passthrough.TLSModeLDAPS, CAPem: dir.CAPem,
		SearchBase: "dc=acme,dc=test", UserFilter: "(mail={email})",
		BindDN: ldaptest.ServiceDN, BindSecret: ldaptest.ServiceSecret,
	}
	if mutate != nil {
		mutate(&s)
	}
	return passthrough.NewService(fixedSource{&s}, &passthrough.Binder{
		Resolver: lookup{ldaptest.Host: {netip.MustParseAddr("93.184.216.34")}},
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, dir.Addr)
		},
		DialTimeout: time.Second, OpTimeout: 2 * time.Second, TotalTimeout: 5 * time.Second,
	})
}

type lookup map[string][]netip.Addr

func (l lookup) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return l[host], nil
}

func TestAManagedAccountBindsThroughTheCompanysDirectory(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS,
		ldaptest.Person{DN: "uid=carol,ou=people,dc=acme,dc=test", Mail: carolMail, Password: carolPass})
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixtureFull(t, managedStore(), v, 60, credcache.New(time.Minute), directoryService(t, dir, nil))

	if got := code(dial(t, addr).Bind(carolDN, "not-her-password")); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("wrong password = %d, want invalidCredentials", got)
	}
	if err := dial(t, addr).Bind(carolDN, carolPass); err != nil {
		t.Fatalf("correct password: %v", err)
	}
	if v.calls != 0 {
		t.Fatalf("Clerk was asked %d times", v.calls)
	}
}

func TestAPersonTheDirectoryDoesNotHaveIsRefusedNotUnavailable(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS,
		ldaptest.Person{DN: "uid=dave,ou=people,dc=acme,dc=test", Mail: "dave@acme.test", Password: "dave"})
	addr := newFixtureFull(t, managedStore(), &fakeVerifier{}, 60, nil, directoryService(t, dir, nil))
	if got := code(dial(t, addr).Bind(carolDN, carolPass)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
}

func TestADirectoryThatCannotBeTrustedIsUnavailableAndGetsNothing(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS,
		ldaptest.Person{DN: "uid=carol,ou=people,dc=acme,dc=test", Mail: carolMail, Password: carolPass})
	for name, mutate := range map[string]func(*passthrough.Settings){
		"the certificate is not trusted": func(s *passthrough.Settings) { s.CAPem = "" },
		"plaintext is asked for":         func(s *passthrough.Settings) { s.TLSMode = "none" },
		"the host is private":            func(s *passthrough.Settings) { s.Host = "127.0.0.1" },
	} {
		t.Run(name, func(t *testing.T) {
			v := &fakeVerifier{outcome: clerkauth.Verified}
			addr := newFixtureFull(t, managedStore(), v, 60, nil, directoryService(t, dir, mutate))
			if got := code(dial(t, addr).Bind(carolDN, carolPass)); got != goldapclient.LDAPResultUnavailable {
				t.Fatalf("result = %d, want unavailable (52)", got)
			}
			if v.calls != 0 {
				t.Fatalf("Clerk was asked %d times", v.calls)
			}
		})
	}
	if got := dir.Binds(); len(got) != 0 {
		t.Fatalf("the directory received binds %v from an unverified or refused connection", got)
	}
}
