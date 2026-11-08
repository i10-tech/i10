package ldapsrv_test

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/passthrough/ldaptest"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// A managed account's password belongs to its company (#344). These pin the
// property that matters: such an account is never sent to Clerk, and an outage
// on the way to the company's directory is "unavailable" - not "wrong
// password", not a question for Clerk, and not a failure the directory counts.
//
// The directory is a verify.Verifier behind the same bind path as Clerk, so the
// failure budget and the identical-retry memory apply to it; the tests below
// that count slots and directory calls are about that. The credential cache
// does not: a directory never reports a password change, so its answers are
// never cached (passthrough.Verifier.MaxCacheTTL).

const (
	carolUID  = "user_carol"
	carolDN   = "uid=user_carol,ou=people,dc=i10,dc=tech"
	carolMail = "carol@acme.test"
	carolPass = "carol-company-password"
	connAcme  = "33333333-3333-4333-8333-333333333333"
	connOther = "44444444-4444-4444-8444-444444444444"
)

func managedStore() *fakeStore {
	store := defaultStore()
	store.accounts = append(store.accounts, projection.Account{
		ClerkUserID:       carolUID,
		Email:             carolMail,
		Active:            true,
		Managed:           true,
		ManagedConnection: connAcme,
	})
	return store
}

// fakeDirectory is a passthrough.Directory that answers from a script and
// records what it was asked. Binds run on a goroutine of the bind path's own.
type fakeDirectory struct {
	result passthrough.Result

	mu    sync.Mutex
	calls int
	conn  string
	email string
}

func (f *fakeDirectory) Bind(_ context.Context, conn, email, _ string) passthrough.Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.conn, f.email = conn, email
	return f.result
}

func (f *fakeDirectory) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeDirectory) setResult(r passthrough.Result) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.result = r
}

func (f *fakeDirectory) asked() (conn, email string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.conn, f.email
}

var (
	resultVerified    = passthrough.Result{Outcome: passthrough.Verified, Reason: passthrough.ReasonVerified}
	resultRejected    = passthrough.Result{Outcome: passthrough.Rejected, Reason: passthrough.ReasonUserBindRejected}
	resultUnavailable = passthrough.Result{Outcome: passthrough.Unavailable, Reason: passthrough.ReasonDialFailed}
)

// failing is an API that cannot be reached.
type failing struct{ err error }

func (f failing) Fetch(context.Context, string) (*passthrough.Answer, error) { return nil, f.err }

// fixedSource answers every connection with the same LDAP settings, or off.
type fixedSource struct{ s *passthrough.Settings }

func (f fixedSource) Fetch(context.Context, string) (*passthrough.Answer, error) {
	if f.s == nil {
		return nil, nil
	}
	return &passthrough.Answer{Lane: passthrough.LaneLDAP, LDAP: f.s}, nil
}

func code(err error) uint16 { return resultCode(err) }

// managedFixture serves store with Clerk as the verifier for everyone no
// connection manages, dir for the rest, and a shared budget store (the
// pass-through verifier has a failure budget, so one is required).
func managedFixture(
	t *testing.T,
	store projection.Store,
	clerk verify.Verifier,
	dir passthrough.Directory,
	cache *credcache.Cache,
) (string, *fakeBudgetStore) {
	t.Helper()
	budget := newFakeBudgetStore()
	return newFixtureOpts(t, fixtureOptions{
		store: store,
		resolver: &passthrough.ManagedResolver{
			Unmanaged: clerk,
			Directory: dir,
		},
		perMinute: 600,
		cache:     cache,
		budget:    budget,
	}), budget
}

func bindCarol(t *testing.T, addr, password string) uint16 {
	t.Helper()
	err := dial(t, addr).Bind(carolDN, password)
	if err == nil {
		return goldapclient.LDAPResultSuccess
	}
	return resultCode(err)
}

// ── Refusals first ───────────────────────────────────────────────────────

func TestAManagedAccountNeverReachesClerk(t *testing.T) {
	for name, tc := range map[string]struct {
		result passthrough.Result
		want   uint16
	}{
		"rejected":    {resultRejected, goldapclient.LDAPResultInvalidCredentials},
		"unavailable": {resultUnavailable, goldapclient.LDAPResultUnavailable},
		"verified":    {resultVerified, goldapclient.LDAPResultSuccess},
	} {
		t.Run(name, func(t *testing.T) {
			// Clerk would say yes to anything. If it is ever asked, this fails.
			clerk := &fakeVerifier{outcome: verify.Verified}
			dir := &fakeDirectory{result: tc.result}
			addr, _ := managedFixture(t, managedStore(), clerk, dir, credcache.New(time.Minute))

			if got := bindCarol(t, addr, carolPass); got != tc.want {
				t.Fatalf("result = %d, want %d", got, tc.want)
			}
			if clerk.callCount() != 0 {
				t.Fatalf("Clerk was asked %d times about a managed account", clerk.callCount())
			}
			if conn, email := dir.asked(); dir.callCount() != 1 || conn != connAcme || email != carolMail {
				t.Fatalf("pass-through saw %d calls, connection %q, address %q", dir.callCount(), conn, email)
			}
		})
	}
}

// A warm entry that Clerk minted must not answer for the company's directory.
// The verifier's name is in the entry, and it carries the connection.
func TestAClerkCacheEntryDoesNotAnswerForAManagedAccount(t *testing.T) {
	store := managedStore()
	clerk := &fakeVerifier{outcome: verify.Verified}
	dir := &fakeDirectory{result: resultRejected}
	addr, _ := managedFixture(t, store, clerk, dir, credcache.New(time.Minute))

	// The same Clerk user verified (and cached) while it was not managed...
	store.accounts[2].Managed = false
	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("unmanaged bind = %d", got)
	}
	if clerk.callCount() != 1 {
		t.Fatalf("verifier called %d times, want 1", clerk.callCount())
	}
	// ...and then the company takes the account over. The warm entry must not
	// answer for it.
	store.accounts[2].Managed = true
	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials: a managed account was served from Clerk's cache", got)
	}
	if dir.callCount() != 1 || clerk.callCount() != 1 {
		t.Fatalf("pass-through %d calls, Clerk %d calls; want 1 and 1", dir.callCount(), clerk.callCount())
	}
}

func TestAManagedAccountWithoutPassThroughIsRefused(t *testing.T) {
	cases := map[string]struct {
		dir  passthrough.Directory
		conn string
	}{
		"the connection has it off": {dir: passthrough.NewService(fixedSource{nil}, &passthrough.Binder{}, nil), conn: connAcme},
		"no pass-through at all":    {dir: nil, conn: connAcme},
		"the connection is gone":    {dir: &fakeDirectory{result: resultVerified}, conn: ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			store := managedStore()
			store.accounts[2].ManagedConnection = tc.conn
			clerk := &fakeVerifier{outcome: verify.Verified}
			addr, _ := managedFixture(t, store, clerk, tc.dir, credcache.New(time.Minute))

			if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
				t.Fatalf("result = %d, want invalidCredentials", got)
			}
			if clerk.callCount() != 0 {
				t.Fatalf("Clerk was asked %d times", clerk.callCount())
			}
			if f, ok := tc.dir.(*fakeDirectory); ok && f.callCount() != 0 {
				t.Fatalf("pass-through was called for an account with no connection")
			}
		})
	}
}

func TestAnUnreachableAPIIsUnavailableNeverAFallbackToClerk(t *testing.T) {
	store := managedStore()
	clerk := &fakeVerifier{outcome: verify.Verified}
	svc := passthrough.NewService(failing{errors.New("api down")}, &passthrough.Binder{}, nil)
	addr, budget := managedFixture(t, store, clerk, svc, nil)

	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52)", got)
	}
	if clerk.callCount() != 0 {
		t.Fatalf("Clerk was asked %d times while the API was down", clerk.callCount())
	}
	// Nothing was forwarded to the directory, so nothing is counted against it.
	if n := budget.count(carolUID); n != 0 {
		t.Fatalf("an outage left %d slots spent", n)
	}

	// Unmanaged accounts keep working exactly as before, API down or not.
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("an unmanaged account could not bind while the API was down: %v", err)
	}
	if clerk.callCount() != 1 {
		t.Fatalf("Clerk called %d times for the unmanaged bind, want 1", clerk.callCount())
	}
}

func TestADeactivatedManagedAccountIsRefusedWithoutAskingAnyone(t *testing.T) {
	store := managedStore()
	store.accounts[2].Active = false
	clerk := &fakeVerifier{outcome: verify.Verified}
	dir := &fakeDirectory{result: resultVerified}
	addr, _ := managedFixture(t, store, clerk, dir, nil)

	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if dir.callCount() != 0 || clerk.callCount() != 0 {
		t.Fatalf("pass-through %d calls, Clerk %d calls; want none", dir.callCount(), clerk.callCount())
	}
}

// Suspension is checked before the verifier is chosen, so a warm entry for a
// managed account cannot open a mailbox the directory switched off.
func TestASuspendedManagedMailboxIsRefusedEvenWithAWarmCache(t *testing.T) {
	store := managedStore()
	clerk := &fakeVerifier{outcome: verify.Verified}
	dir := &fakeDirectory{result: resultVerified}
	addr, _ := managedFixture(t, store, clerk, dir, credcache.New(time.Hour))

	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("bind before the suspension = %d", got)
	}
	store.accounts[2].Suspended = true
	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("a suspended managed mailbox bound from the cache: result = %d", got)
	}
	if dir.callCount() != 1 {
		t.Fatalf("the directory was asked %d times, want only the first bind", dir.callCount())
	}
}

func TestAnEmptyPasswordForAManagedAccountReachesNothing(t *testing.T) {
	clerk := &fakeVerifier{outcome: verify.Verified}
	dir := &fakeDirectory{result: resultVerified}
	addr, budget := managedFixture(t, managedStore(), clerk, dir, nil)
	// The client library refuses to send an empty password; this sends one.
	if got := code(dial(t, addr).UnauthenticatedBind(carolDN)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if reserves, _ := budget.counts(); dir.callCount() != 0 || clerk.callCount() != 0 || reserves != 0 {
		t.Fatalf("pass-through %d calls, Clerk %d calls, %d slots reserved; want none",
			dir.callCount(), clerk.callCount(), reserves)
	}
}

func TestTheThrottleStillGuardsManagedBinds(t *testing.T) {
	dir := &fakeDirectory{result: resultRejected}
	budget := newFakeBudgetStore()
	addr := newFixtureOpts(t, fixtureOptions{
		store:     managedStore(),
		resolver:  &passthrough.ManagedResolver{Unmanaged: &fakeVerifier{}, Directory: dir},
		perMinute: 1, // a burst of 1
		budget:    budget,
	})
	// Two different wrong passwords: an identical one is answered from memory
	// before the throttle, which is the other test's business.
	_ = bindCarol(t, addr, "wrong-1")
	if got := bindCarol(t, addr, "wrong-2"); got != goldapclient.LDAPResultBusy {
		t.Fatalf("second bind = %d, want busy (51)", got)
	}
	if dir.callCount() != 1 {
		t.Fatalf("the company's directory was asked %d times, want 1", dir.callCount())
	}
}

// ── The failure budget, the cache and the outage rules ───────────────────

// ⚠ A COMPANY'S DIRECTORY LOCKS THE REAL ACCOUNT. A wrong password is the one
// answer that is a failure the directory counted, so it keeps its slot.
func TestAWrongManagedPasswordIs49AndSpendsASlot(t *testing.T) {
	dir := &fakeDirectory{result: resultRejected}
	addr, budget := managedFixture(t, managedStore(), &fakeVerifier{}, dir, nil)

	if got := bindCarol(t, addr, "wrong-1"); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials (49)", got)
	}
	reserves, releases := budget.counts()
	if reserves != 1 || releases != 0 || budget.count(carolUID) != 1 {
		t.Fatalf("reserves=%d releases=%d spent=%d; a wrong password must keep exactly one slot",
			reserves, releases, budget.count(carolUID))
	}
	if dir.callCount() != 1 {
		t.Fatalf("the directory was asked %d times, want 1", dir.callCount())
	}
}

// Three forwarded failures in fifteen minutes, then the directory is left alone.
func TestAManagedAccountGetsThreeForwardedFailuresPerWindow(t *testing.T) {
	dir := &fakeDirectory{result: resultRejected}
	addr, budget := managedFixture(t, managedStore(), &fakeVerifier{}, dir, nil)

	for i := 1; i <= 3; i++ {
		if got := bindCarol(t, addr, wrong(i)); got != goldapclient.LDAPResultInvalidCredentials {
			t.Fatalf("failure %d: result = %d, want 49", i, got)
		}
	}
	if got := bindCarol(t, addr, wrong(4)); got != goldapclient.LDAPResultBusy {
		t.Fatalf("the failure past the budget gave %d, want busy (51)", got)
	}
	if dir.callCount() != 3 {
		t.Fatalf("the directory was asked %d times, want it to stay at 3", dir.callCount())
	}

	// A new window gives the person their attempts back.
	budget.advance(passthrough.FailureBudget.Window)
	if got := bindCarol(t, addr, wrong(5)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("after the window: result = %d, want 49", got)
	}
	if dir.callCount() != 4 {
		t.Fatalf("the directory was asked %d times, want 4", dir.callCount())
	}
}

// ⚠ AN OUTAGE IS NOT A FAILURE. The directory not answering must not read as a
// wrong password, and must not use up the slots that protect the real account.
func TestAnUnreachableDirectoryIsUnavailableNotInvalidAndGivesTheSlotBack(t *testing.T) {
	dir := &fakeDirectory{result: resultUnavailable}
	addr, budget := managedFixture(t, managedStore(), &fakeVerifier{}, dir, nil)

	for i := 1; i <= 5; i++ { // more than the budget: none of them is a failure
		if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultUnavailable {
			t.Fatalf("bind %d: result = %d, want unavailable (52), never 49", i, got)
		}
	}
	reserves, releases := budget.counts()
	if reserves != 5 || releases != 5 || budget.count(carolUID) != 0 {
		t.Fatalf("reserves=%d releases=%d spent=%d; every outage must give its slot back",
			reserves, releases, budget.count(carolUID))
	}

	// The directory comes back, and the person's real password works at once.
	dir.setResult(resultVerified)
	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("after the outage: result = %d, want success", got)
	}
}

// A directory never reports a password change, so its yes is never remembered:
// every bind asks it again, even with a long credential cache configured.
func TestAManagedPasswordIsAskedOfTheDirectoryEveryTime(t *testing.T) {
	dir := &fakeDirectory{result: resultVerified}
	addr, budget := managedFixture(t, managedStore(), &fakeVerifier{}, dir, credcache.New(2*time.Hour))

	for i := 0; i < 3; i++ {
		if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultSuccess {
			t.Fatalf("bind %d: result = %d", i, got)
		}
	}
	if dir.callCount() != 3 {
		t.Fatalf("the directory was asked %d times for 3 binds, want 3: a directory answer was cached", dir.callCount())
	}
	if reserves, releases := budget.counts(); reserves != releases {
		t.Fatalf("%d slots reserved and %d released for 3 successes: a success kept a slot", reserves, releases)
	}

	// The password the directory stopped accepting is refused at once.
	dir.setResult(resultRejected)
	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("a password the directory now refuses gave %d, want invalidCredentials", got)
	}
}

// ── Against a real directory, end to end ─────────────────────────────────

func directoryService(t *testing.T, dir *ldaptest.Server, mutate func(*passthrough.Settings)) *passthrough.Service {
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
	}, nil)
}

type lookup map[string][]netip.Addr

func (l lookup) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return l[host], nil
}

func TestAManagedAccountBindsThroughTheCompanysDirectory(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS,
		ldaptest.Person{DN: "uid=carol,ou=people,dc=acme,dc=test", Mail: carolMail, Password: carolPass})
	clerk := &fakeVerifier{outcome: verify.Verified}
	addr, budget := managedFixture(t, managedStore(), clerk, directoryService(t, dir, nil), credcache.New(time.Minute))

	if got := bindCarol(t, addr, "not-her-password"); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("wrong password = %d, want invalidCredentials", got)
	}
	if n := budget.count(carolUID); n != 1 {
		t.Fatalf("a wrong password left %d slots spent, want 1", n)
	}
	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("correct password = %d", got)
	}
	if n := budget.count(carolUID); n != 1 {
		t.Fatalf("a success changed the slots spent to %d, want it to stay 1", n)
	}
	if clerk.callCount() != 0 {
		t.Fatalf("Clerk was asked %d times", clerk.callCount())
	}
}

func TestAPersonTheDirectoryDoesNotHaveIsRefusedNotUnavailable(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS,
		ldaptest.Person{DN: "uid=dave,ou=people,dc=acme,dc=test", Mail: "dave@acme.test", Password: "dave"})
	addr, _ := managedFixture(t, managedStore(), &fakeVerifier{}, directoryService(t, dir, nil), nil)
	if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultInvalidCredentials {
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
			clerk := &fakeVerifier{outcome: verify.Verified}
			addr, budget := managedFixture(t, managedStore(), clerk, directoryService(t, dir, mutate), nil)
			if got := bindCarol(t, addr, carolPass); got != goldapclient.LDAPResultUnavailable {
				t.Fatalf("result = %d, want unavailable (52)", got)
			}
			if clerk.callCount() != 0 {
				t.Fatalf("Clerk was asked %d times", clerk.callCount())
			}
			if n := budget.count(carolUID); n != 0 {
				t.Fatalf("a connection we refused to use left %d slots spent, want 0", n)
			}
		})
	}
	if got := dir.Binds(); len(got) != 0 {
		t.Fatalf("the directory received binds %v from an unverified or refused connection", got)
	}
}
