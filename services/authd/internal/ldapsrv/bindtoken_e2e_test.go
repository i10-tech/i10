package ldapsrv_test

import (
	"strings"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// The mail front's token is the attribution boundary (#383): a person bind
// without a valid token for the account its DN names is refused, whatever the
// password.

func invalid(t *testing.T, err error) {
	t.Helper()
	if code := resultCode(err); code != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("bind answered %v (code %d), want invalidCredentials", err, code)
	}
}

func TestAPersonBindNeedsAValidTokenForItsOwnAccount(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixture(t, defaultStore(), v, 600)

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("a bind through the front was refused: %v", err)
	}

	bobsToken, _ := bindtoken.Wrap(testTokenKey, "user_bob", alicePass, time.Now())
	stale, _ := bindtoken.Wrap(testTokenKey, "user_alice", alicePass, time.Now().Add(-2*bindtoken.TTL))
	otherKey := bindtoken.Key{ID: 9, Secret: []byte(strings.Repeat("k", 32))}
	foreign, _ := bindtoken.Wrap(otherKey, "user_alice", alicePass, time.Now())
	alicesToken, _ := bindtoken.Wrap(testTokenKey, "user_alice", alicePass, time.Now())
	for name, password := range map[string]string{
		"the right password, raw":        alicePass,
		"a token for another account":    bobsToken,
		"a token past its minute":        stale,
		"the prefix with nothing behind": bindtoken.Prefix,
		"a token with its mac mangled":   mangleMAC(alicesToken),
	} {
		t.Run(name, func(t *testing.T) { invalid(t, dial(t, addr).RawBind(aliceDN, password)) })
	}
	// A key id authd does not hold is a rotation gone wrong on our side, so it is
	// unavailable, never a wrong password.
	unavailable(t, dial(t, addr).RawBind(aliceDN, foreign))
	if v.calls != 1 {
		t.Fatalf("the verifier was asked %d times, want once: only the bind with a token reaches it", v.calls)
	}
}

// mangleMAC changes one character inside the token's MAC, past the key id, so
// the key is still known and only the MAC is wrong.
func mangleMAC(token string) string {
	i := len(bindtoken.Prefix) + 60
	c := byte('A')
	if token[i] == 'A' {
		c = 'B'
	}
	return token[:i] + string(c) + token[i+1:]
}

func unavailable(t *testing.T, err error) {
	t.Helper()
	if code := resultCode(err); code != goldapclient.LDAPResultUnavailable {
		t.Fatalf("bind answered %v (code %d), want unavailable", err, code)
	}
}

// ⚠ NO KEYS, NO PERSON BINDS, and no fallback to the raw password. The answer
// is unavailable, not invalidCredentials: the fault is ours, and a mail client
// told the password is wrong asks its user for it. The service bind, which
// Stalwart's delivery needs, still works.
func TestWithNoKeysEveryPersonBindIsRefusedAndTheServiceBindStillWorks(t *testing.T) {
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureOpts(t, fixtureOptions{store: defaultStore(), resolver: verify.Fixed(v), perMinute: 600, noKeys: true})
	unavailable(t, dial(t, addr).Bind(aliceDN, alicePass))
	unavailable(t, dial(t, addr).RawBind(aliceDN, alicePass))
	if v.calls != 0 {
		t.Fatalf("the verifier was asked %d times with no keys", v.calls)
	}
	if err := dial(t, addr).RawBind(svcDN, svcSecret); err != nil {
		t.Fatalf("the service bind failed with no token keys: %v", err)
	}
}

// ⚠ A REFUSED BIND COSTS THE ACCOUNT NOTHING. A client signed in as itself can
// send LOGIN with a victim's name as often as it likes; none of it may reach the
// victim's failure budget, the per-DN throttle or the provider.
func TestARefusedBindTouchesNoBudgetNoThrottleAndNoProvider(t *testing.T) {
	v := budgeted()
	budget := newFakeBudgetStore()
	// One bind a minute for the DN: a refused bind that spent the token would
	// leave none for the real one.
	addr := newFixtureOpts(t, fixtureOptions{
		store: defaultStore(), resolver: verify.Fixed(v), perMinute: 1, budget: budget,
	})
	for i := 0; i < 20; i++ {
		invalid(t, dial(t, addr).RawBind(aliceDN, wrong(i)))
	}
	budget.mu.Lock()
	reserves := budget.reserves
	budget.mu.Unlock()
	if reserves != 0 || v.callCount() != 0 {
		t.Fatalf("20 refused binds reserved %d budget slots and reached the provider %d times, want none", reserves, v.callCount())
	}
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("the real sign-in after them was refused: %v (the throttle or the budget was spent)", err)
	}
}

// The pass-through lanes' accounts have the same DN shape, so the token covers
// them the same way: a managed account's raw bind never reaches its company's
// directory.
func TestAManagedAccountsBindNeedsTheTokenToo(t *testing.T) {
	store := defaultStore()
	for i := range store.accounts {
		if store.accounts[i].ClerkUserID == "user_alice" {
			store.accounts[i].Managed, store.accounts[i].ManagedConnection = true, "conn-1"
		}
	}
	v := &fakeVerifier{name: "passthrough:conn-1", outcome: verify.Verified}
	addr := newFixture(t, store, v, 600)
	invalid(t, dial(t, addr).RawBind(aliceDN, alicePass))
	if v.calls != 0 {
		t.Fatalf("a raw bind reached the company's directory %d times", v.calls)
	}
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil || v.calls != 1 {
		t.Fatalf("the bind through the front: %v, %d calls", err, v.calls)
	}
}

// Rotation: authd accepts the old and the new key while the front moves over.
func TestBothKeysAreAcceptedDuringARotation(t *testing.T) {
	next := bindtoken.Key{ID: 2, Secret: []byte(strings.Repeat("n", 32))}
	v := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureOpts(t, fixtureOptions{
		store: defaultStore(), resolver: verify.Fixed(v), perMinute: 600,
		keys: bindtoken.Keys{testTokenKey.ID: testTokenKey.Secret, next.ID: next.Secret},
	})
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("the old key: %v", err)
	}
	wrapped, _ := bindtoken.Wrap(next, "user_alice", alicePass, time.Now())
	if err := dial(t, addr).RawBind(aliceDN, wrapped); err != nil {
		t.Fatalf("the new key: %v", err)
	}
}
