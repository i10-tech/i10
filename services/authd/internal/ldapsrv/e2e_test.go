package ldapsrv_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"
	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/clerkauth"
	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/ldapsrv"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/throttle"
)

const (
	baseDN     = "dc=i10,dc=tech"
	svcDN      = "cn=stalwart,ou=services,dc=i10,dc=tech"
	svcSecret  = "service-secret"
	aliceDN    = "uid=user_alice,ou=people,dc=i10,dc=tech"
	supportDN  = "cn=support,ou=groups,dc=i10,dc=tech"
	alicePass  = "alice-password"
	aliceEmail = "alice@i10.tech"
)

// Stalwart's documented default filters, verbatim, with ? substituted the way
// Stalwart substitutes it. If these stop passing, the deployed directory
// configuration stops working.
const (
	filterLogin    = "(&(objectClass=inetOrgPerson)(mail=%s))"
	filterMailbox  = "(|(&(objectClass=inetOrgPerson)(|(mail=%s)(mailAlias=%s)))(&(objectClass=groupOfNames)(|(mail=%s)(mailAlias=%s))))"
	filterMemberOf = "(&(objectClass=groupOfNames)(member=%s))"
)

// ldap.Logger is a package-level global. Setting it per fixture would race
// with the server goroutines of tests already running, so it is set once here.
func TestMain(m *testing.M) {
	ldap.Logger = slog.NewLogLogger(slog.NewTextHandler(io.Discard, nil), slog.LevelDebug)
	os.Exit(m.Run())
}

type fakeStore struct {
	accounts []projection.Account
	groups   []projection.Group
	err      error
}

func (f *fakeStore) AccountsByAddress(_ context.Context, addrs []string) ([]projection.Account, error) {
	if f.err != nil {
		return nil, f.err
	}
	var out []projection.Account
	for _, a := range f.accounts {
		if !a.Active {
			continue
		}
		for _, want := range addrs {
			if strings.EqualFold(a.Email, want) || containsFold(a.Aliases, want) {
				out = append(out, a)
				break
			}
		}
	}
	return out, nil
}

func (f *fakeStore) AccountByUID(_ context.Context, uid string) (*projection.Account, error) {
	if f.err != nil {
		return nil, f.err
	}
	for i, a := range f.accounts {
		if a.ClerkUserID == uid && a.Active {
			return &f.accounts[i], nil
		}
	}
	return nil, nil
}

func (f *fakeStore) GroupsByAddress(_ context.Context, addrs []string) ([]projection.Group, error) {
	if f.err != nil {
		return nil, f.err
	}
	var out []projection.Group
	for _, g := range f.groups {
		for _, want := range addrs {
			if g.Email != "" && strings.EqualFold(g.Email, want) {
				out = append(out, g)
				break
			}
		}
	}
	return out, nil
}

func (f *fakeStore) GroupsForMember(_ context.Context, uid string) ([]projection.Group, error) {
	if f.err != nil {
		return nil, f.err
	}
	var out []projection.Group
	for _, g := range f.groups {
		for _, m := range g.Members {
			if m == uid {
				out = append(out, g)
				break
			}
		}
	}
	return out, nil
}

func containsFold(hay []string, needle string) bool {
	for _, h := range hay {
		if strings.EqualFold(h, needle) {
			return true
		}
	}
	return false
}

type fakeVerifier struct {
	outcome clerkauth.Outcome
	err     error
	calls   int
}

func (f *fakeVerifier) Verify(context.Context, string, string) (clerkauth.Outcome, error) {
	f.calls++
	return f.outcome, f.err
}

func newFixture(t *testing.T, store projection.Store, v ldapsrv.Verifier, perMinute int) string {
	t.Helper()
	// No credential cache: every existing test asserts on how many times the
	// verifier was called, and a cache would silently change those counts.
	return newFixtureWith(t, store, v, perMinute, nil)
}

func newFixtureWith(t *testing.T, store projection.Store, v ldapsrv.Verifier, perMinute int, cache *credcache.Cache) string {
	t.Helper()

	srv := ldap.NewServer()
	srv.Handle(ldapsrv.New(ldapsrv.Options{
		BaseDN:            baseDN,
		ServiceBindDN:     svcDN,
		ServiceBindSecret: svcSecret,
		Store:             store,
		Verifier:          v,
		Limiter:           throttle.New(perMinute),
		CredCache:         cache,
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
		OpTimeout:         2 * time.Second,
	}).Routes())

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	// Shut down by closing the listener rather than calling srv.Stop().
	//
	// ldapserver has a data race between Serve, which assigns s.Listener, and
	// Stop, which reads it — both unsynchronised (server.go:82 vs :186). Closing
	// the listener we own makes the accept loop return, and the only goroutine
	// touching s.Listener is the one running Serve.
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
	})
	return ln.Addr().String()
}

func defaultStore() *fakeStore {
	changed := time.Date(2026, 8, 30, 9, 0, 0, 0, time.UTC)
	return &fakeStore{
		accounts: []projection.Account{{
			ClerkUserID:    "user_alice",
			Email:          aliceEmail,
			DisplayName:    "Alice Example",
			Active:         true,
			ClerkUpdatedAt: &changed,
			Aliases:        []string{"a@i10.tech", "alice.example@i10.tech"},
			MemberOf:       []string{"support"},
		}, {
			ClerkUserID: "user_suspended",
			Email:       "gone@i10.tech",
			Active:      false, // unpaid, suspended, or deprovisioned
		}},
		groups: []projection.Group{{
			Name:    "support",
			Email:   "support@i10.tech",
			Members: []string{"user_alice"},
		}},
	}
}

func dial(t *testing.T, addr string) *goldapclient.Conn {
	t.Helper()
	c, err := goldapclient.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func resultCode(err error) uint16 {
	var le *goldapclient.Error
	if errors.As(err, &le) {
		return le.ResultCode
	}
	return 0
}

// ---------------------------------------------------------------- bind

func TestServiceBind(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)

	if err := dial(t, addr).Bind(svcDN, svcSecret); err != nil {
		t.Fatalf("service bind failed: %v", err)
	}
	err := dial(t, addr).Bind(svcDN, "wrong")
	if got := resultCode(err); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("wrong service secret gave %d, want %d",
			got, goldapclient.LDAPResultInvalidCredentials)
	}
}

func TestUserBindOutcomes(t *testing.T) {
	tests := []struct {
		name     string
		outcome  clerkauth.Outcome
		verErr   error
		wantCode uint16
	}{
		{"verified", clerkauth.Verified, nil, goldapclient.LDAPResultSuccess},
		{"rejected", clerkauth.Rejected, nil, goldapclient.LDAPResultInvalidCredentials},
		// ⚠ The load-bearing case. A Clerk outage must NOT look like a wrong
		// password, or every mail client prompts its user and people start
		// changing passwords to fix an outage that was never theirs.
		{"clerk down", clerkauth.Unavailable, errors.New("boom"), goldapclient.LDAPResultUnavailable},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v := &fakeVerifier{outcome: tc.outcome, err: tc.verErr}
			addr := newFixture(t, defaultStore(), v, 60)

			err := dial(t, addr).Bind(aliceDN, alicePass)
			got := uint16(goldapclient.LDAPResultSuccess)
			if err != nil {
				got = resultCode(err)
			}
			if got != tc.wantCode {
				t.Fatalf("result = %d, want %d (err %v)", got, tc.wantCode, err)
			}
			if v.calls != 1 {
				t.Errorf("verifier called %d times, want 1", v.calls)
			}
		})
	}
}

func TestSuspendedAccountCannotBind(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixture(t, defaultStore(), v, 60)

	err := dial(t, addr).Bind("uid=user_suspended,ou=people,"+baseDN, "any-password")
	if got := resultCode(err); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	// The gate must close before Clerk is consulted: a suspended account should
	// not be able to spend our Clerk budget at all.
	if v.calls != 0 {
		t.Errorf("verifier called %d times for a suspended account, want 0", v.calls)
	}
}

func TestUnknownDNDoesNotReachClerk(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixture(t, defaultStore(), v, 60)

	err := dial(t, addr).Bind("uid=nobody,ou=people,"+baseDN, "pw")
	if got := resultCode(err); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials", got)
	}
	if v.calls != 0 {
		t.Errorf("verifier called %d times, want 0", v.calls)
	}
}

func TestProjectionDownIsUnavailableNotInvalidCredentials(t *testing.T) {
	store := defaultStore()
	store.err = errors.New("connection refused")
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixture(t, store, v, 60)

	err := dial(t, addr).Bind(aliceDN, alicePass)
	if got := resultCode(err); got != goldapclient.LDAPResultUnavailable {
		t.Fatalf("result = %d, want unavailable (52)", got)
	}
}

func TestThrottleReturnsBusyNotInvalidCredentials(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixture(t, defaultStore(), v, 1) // burst of 1

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("first bind failed: %v", err)
	}
	err := dial(t, addr).Bind(aliceDN, alicePass)
	if got := resultCode(err); got != goldapclient.LDAPResultBusy {
		t.Fatalf("throttled bind gave %d, want busy (51)", got)
	}
	if v.calls != 1 {
		t.Errorf("verifier called %d times; the throttle must sit in front of Clerk", v.calls)
	}
}

func TestEmptyPasswordNeverReachesClerk(t *testing.T) {
	v := &fakeVerifier{outcome: clerkauth.Verified}
	addr := newFixture(t, defaultStore(), v, 60)

	// RFC 4513 §5.1.2: this is an unauthenticated bind, not a verification.
	err := dial(t, addr).Bind(aliceDN, "")
	if err == nil {
		t.Fatal("empty password bind succeeded")
	}
	if v.calls != 0 {
		t.Errorf("verifier called %d times for an empty password, want 0", v.calls)
	}
}

// ---------------------------------------------------------------- search

func search(t *testing.T, addr, filter string, attrs ...string) []*goldapclient.Entry {
	t.Helper()
	c := dial(t, addr)
	if err := c.Bind(svcDN, svcSecret); err != nil {
		t.Fatalf("service bind: %v", err)
	}
	res, err := c.Search(goldapclient.NewSearchRequest(
		baseDN, goldapclient.ScopeWholeSubtree, goldapclient.NeverDerefAliases,
		0, 0, false, filter, attrs, nil))
	if err != nil {
		t.Fatalf("search %q: %v", filter, err)
	}
	return res.Entries
}

func TestFilterLoginResolvesDN(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)

	entries := search(t, addr, fmt.Sprintf(filterLogin, aliceEmail))
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].DN != aliceDN {
		t.Errorf("DN = %q, want %q", entries[0].DN, aliceDN)
	}
	// Stalwart reads this to expire cached OAuth tokens on a password change.
	if got := entries[0].GetAttributeValue("pwdChangeTime"); got != "20260830090000Z" {
		t.Errorf("pwdChangeTime = %q", got)
	}
	// bindAuthentication=true means Stalwart never reads a password attribute,
	// and authd must never invent one.
	if got := entries[0].GetAttributeValue("userPassword"); got != "" {
		t.Errorf("userPassword present: %q", got)
	}
}

func TestFilterLoginRejectsSuspendedAccount(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)
	if got := search(t, addr, fmt.Sprintf(filterLogin, "gone@i10.tech")); len(got) != 0 {
		t.Fatalf("suspended account resolved: %v", got[0].DN)
	}
}

func TestFilterMailboxAcceptsPrimaryAliasAndGroup(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)

	for _, tc := range []struct{ addr, wantDN string }{
		{aliceEmail, aliceDN},
		{"a@i10.tech", aliceDN},         // alias
		{"ALICE@I10.TECH", aliceDN},     // addresses are case-insensitive
		{"support@i10.tech", supportDN}, // mail-enabled group
	} {
		f := fmt.Sprintf(filterMailbox, tc.addr, tc.addr, tc.addr, tc.addr)
		entries := search(t, addr, f)
		if len(entries) != 1 {
			t.Fatalf("%s: got %d entries, want 1", tc.addr, len(entries))
		}
		if entries[0].DN != tc.wantDN {
			t.Errorf("%s: DN = %q, want %q", tc.addr, entries[0].DN, tc.wantDN)
		}
	}
}

// This is the property that made the LDAP bridge worth building: an account
// that has never signed in still resolves as a recipient. The OIDC directory
// cannot do this, which is why it forced pre-creation of every mailbox.
func TestFilterMailboxRejectsUnknownRecipient(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)
	f := fmt.Sprintf(filterMailbox, "nobody@i10.tech", "nobody@i10.tech", "nobody@i10.tech", "nobody@i10.tech")
	if got := search(t, addr, f); len(got) != 0 {
		t.Fatalf("unknown recipient resolved to %v", got[0].DN)
	}
}

func TestFilterMemberOf(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)

	entries := search(t, addr, fmt.Sprintf(filterMemberOf, aliceDN))
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0].DN != supportDN {
		t.Errorf("DN = %q, want %q", entries[0].DN, supportDN)
	}
}

func TestAttributeSelection(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)

	entries := search(t, addr, fmt.Sprintf(filterLogin, aliceEmail), "mail")
	if len(entries) != 1 {
		t.Fatalf("got %d entries", len(entries))
	}
	if n := len(entries[0].Attributes); n != 1 {
		var names []string
		for _, a := range entries[0].Attributes {
			names = append(names, a.Name)
		}
		t.Fatalf("got %d attributes %v, want only mail", n, names)
	}
}

// Writes must not exist at all. Every operation authd does not implement is one
// that cannot be abused through it.
func TestWriteOperationsAreRefused(t *testing.T) {
	addr := newFixture(t, defaultStore(), &fakeVerifier{}, 60)
	c := dial(t, addr)
	if err := c.Bind(svcDN, svcSecret); err != nil {
		t.Fatalf("service bind: %v", err)
	}

	add := goldapclient.NewAddRequest("uid=intruder,ou=people,"+baseDN, nil)
	add.Attribute("objectClass", []string{"inetOrgPerson"})
	if err := c.Add(add); err == nil {
		t.Error("Add succeeded; the directory must be read-only")
	}
	if err := c.Del(goldapclient.NewDelRequest(aliceDN, nil)); err == nil {
		t.Error("Delete succeeded; the directory must be read-only")
	}
	mod := goldapclient.NewModifyRequest(aliceDN, nil)
	mod.Replace("mail", []string{"attacker@evil.example"})
	if err := c.Modify(mod); err == nil {
		t.Error("Modify succeeded; the directory must be read-only")
	}
}
