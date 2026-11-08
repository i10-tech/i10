package ldapsrv_test

import (
	"context"
	"os"
	"testing"
	"time"

	goldapclient "github.com/go-ldap/ldap/v3"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/i10-tech/i10/services/authd/internal/credcache"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// The people SSO itself exempts (owners and admins while the owner exemption is
// on, a connection's bypass list) keep their Clerk password for mail on a domain
// where SSO is required: the owner's decision, consistent with how they keep the
// console. Taking somebody OUT of the exemption is a revocation, so it has to beat
// a warm credential cache like every other reason a login ends.

// ⚠ THE CACHE WAS PRIMED FIRST, AND THAT IS THE TEST. The exempt person's password
// is cached under the Clerk verifier's name; the refusal that follows their removal
// has a name of its own, so the entry cannot match it. A refusal checked against a
// cold cache would pass even if the exemption were consulted after the cache.
func TestAnExemptAccountKeepsItsClerkPasswordUntilItIsRemoved(t *testing.T) {
	store := defaultStore()
	store.accounts[0].SSORequired = true
	store.accounts[0].SSOExempt = true
	clerk := &fakeVerifier{outcome: verify.Verified}
	dir := &fakeDirectory{result: resultVerified}
	addr, _ := managedFixture(t, store, clerk, dir, credcache.New(2*time.Hour))

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("an exempt account on a required domain was refused: %v", err)
	}
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("cached bind: %v", err)
	}
	if clerk.callCount() != 1 {
		t.Fatalf("clerk called %d times, want 1: the cache was not warm", clerk.callCount())
	}

	// Removed from the exemption (a demotion, the bypass list, the owner exemption
	// turned off): the very next bind is refused, and nothing was asked of a provider.
	store.accounts[0].SSOExempt = false
	if got := resultCode(dial(t, addr).Bind(aliceDN, alicePass)); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("result = %d, want invalidCredentials once the exemption is gone", got)
	}
	if clerk.callCount() != 1 || dir.callCount() != 0 {
		t.Fatalf("clerk called %d, directory %d: an account that lost its exemption was asked of a provider",
			clerk.callCount(), dir.callCount())
	}

	// Back in: the same cached entry answers again, with no new provider call.
	store.accounts[0].SSOExempt = true
	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("bind after being exempted again: %v", err)
	}
}

// An exemption says nothing where SSO is not required, and an account that is not
// exempt is refused exactly as before: the exemption is a pass, never a refusal.
func TestExemptionDoesNotChangeAnAccountNothingIsRequiredOf(t *testing.T) {
	store := defaultStore()
	store.accounts[0].SSOExempt = true
	clerk := &fakeVerifier{outcome: verify.Verified}
	addr := newFixtureWith(t, store, clerk, 600, nil)

	if err := dial(t, addr).Bind(aliceDN, alicePass); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if clerk.callCount() != 1 {
		t.Fatalf("clerk called %d times, want 1", clerk.callCount())
	}
}

// What the in-memory store cannot show: the real query, as the `authd` role, over
// the rows the API writes (`authd.required_domains` and `authd.required_exempt`),
// through the real server. Skipped unless both database URLs are set, like the
// projection's tests; the privileged connection writes the rows because the
// `authd` role can only read them.
func TestAnExemptOwnerBindsOnARequiredDomainAndLosesItAtTheNextBind(t *testing.T) {
	dsn, admin := os.Getenv("AUTHD_TEST_DATABASE_URL"), os.Getenv("AUTHD_TEST_ADMIN_DATABASE_URL")
	if dsn == "" || admin == "" {
		t.Skip("AUTHD_TEST_DATABASE_URL and AUTHD_TEST_ADMIN_DATABASE_URL are not both set")
	}
	ctx := context.Background()

	w, err := pgxpool.New(ctx, admin)
	if err != nil {
		t.Fatalf("connect as admin: %v", err)
	}
	t.Cleanup(w.Close)

	const (
		id    = "user_exempt_e2e"
		email = "owner@exempt-e2e.test"
		slug  = "exempt-e2e"
		conn  = "77777777-7777-4777-8777-777777777777"
		other = "88888888-8888-4888-8888-888888888888"
		dn    = "uid=" + id + ",ou=people,dc=i10,dc=tech"
		pass  = "owner-password"
	)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := w.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %q: %v", sql, err)
		}
	}
	purge := func() {
		if _, err := w.Exec(ctx, `DELETE FROM authd.accounts WHERE clerk_user_id = $1`, id); err != nil {
			t.Logf("purge account: %v", err)
		}
		// Takes the connections and their required-domain and exempt rows with it.
		if _, err := w.Exec(ctx, `DELETE FROM core.tenants WHERE slug = $1`, slug); err != nil {
			t.Logf("purge tenant: %v", err)
		}
	}
	purge()
	t.Cleanup(purge)

	exec(`INSERT INTO core.tenants (slug, name, owner_clerk_user_id) VALUES ($1, 'Exempt e2e', $2)`, slug, id)
	for _, c := range []string{conn, other} {
		exec(`INSERT INTO identity.connections (id, tenant_id, name, protocol)
			SELECT $1::uuid, id, 'Test connection', 'saml' FROM core.tenants WHERE slug = $2`, c, slug)
	}
	exec(`INSERT INTO authd.accounts (clerk_user_id, email, active, tenant_id)
		SELECT $1, $2, true, id FROM core.tenants WHERE slug = $3`, id, email, slug)
	exec(`INSERT INTO authd.required_domains (domain, tenant_id, connection_id)
		SELECT 'exempt-e2e.test', id, $1::uuid FROM core.tenants WHERE slug = $2`, conn, slug)

	store, err := projection.NewPostgres(ctx, dsn)
	if err != nil {
		t.Fatalf("NewPostgres: %v", err)
	}
	t.Cleanup(store.Close)

	clerk := &fakeVerifier{outcome: verify.Verified}
	addr, _ := managedFixture(t, store, clerk, &fakeDirectory{result: resultVerified}, credcache.New(2*time.Hour))
	bind := func() uint16 {
		t.Helper()
		if err := dial(t, addr).Bind(dn, pass); err != nil {
			return resultCode(err)
		}
		return goldapclient.LDAPResultSuccess
	}
	grant := func(connection, source string) {
		exec(`INSERT INTO authd.required_exempt (connection_id, tenant_id, clerk_user_id, source)
			SELECT $1::uuid, id, $2, $3 FROM core.tenants WHERE slug = $4`, connection, id, source, slug)
	}

	// Required for the domain and nobody exempt: the Clerk password is refused.
	if got := bind(); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("an unexempt account on a required domain: result = %d, want invalidCredentials", got)
	}
	if clerk.callCount() != 0 {
		t.Fatalf("clerk called %d times for a refused account", clerk.callCount())
	}

	// A pass for ANOTHER connection says nothing about this domain's.
	grant(other, "bypass")
	if got := bind(); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("a bypass for another connection opened this domain: result = %d", got)
	}

	// The owner exemption: the Clerk password works, and is cached.
	grant(conn, "owner_exemption")
	if got := bind(); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("an exempt owner on a required domain: result = %d, want success", got)
	}
	if got := bind(); got != goldapclient.LDAPResultSuccess || clerk.callCount() != 1 {
		t.Fatalf("second bind: result = %d, clerk called %d times, want success from the cache", got, clerk.callCount())
	}

	// Removed from the exemption (the API recomputed the set): refused at the very
	// next bind although the password is cached, and Clerk is not asked.
	exec(`DELETE FROM authd.required_exempt WHERE clerk_user_id = $1 AND connection_id = $2::uuid`, id, conn)
	if got := bind(); got != goldapclient.LDAPResultInvalidCredentials {
		t.Fatalf("after losing the exemption: result = %d, want invalidCredentials", got)
	}
	if clerk.callCount() != 1 {
		t.Fatalf("clerk called %d times: a revoked account reached the provider", clerk.callCount())
	}

	// A bypass entry on the right connection restores it; deleting the connection
	// (and with it the rows) takes it away again.
	grant(conn, "bypass")
	if got := bind(); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("a bypass entry on the domain's connection: result = %d, want success", got)
	}
	exec(`DELETE FROM authd.required_domains WHERE domain = 'exempt-e2e.test'`)
	// Not required any more: nothing is refused, exempt or not.
	if got := bind(); got != goldapclient.LDAPResultSuccess {
		t.Fatalf("once SSO is no longer required: result = %d, want success", got)
	}
}
