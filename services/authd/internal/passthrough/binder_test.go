package passthrough_test

import (
	"context"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/passthrough"
	"github.com/i10-tech/i10/services/authd/internal/passthrough/ldaptest"
)

const (
	adaDN   = "uid=ada,ou=people,dc=acme,dc=test"
	adaMail = "ada@acme.test"
	adaPass = "ada-company-password"
)

var publicIP = netip.MustParseAddr("93.184.216.34")

type resolver map[string][]netip.Addr

func (r resolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	return r[host], nil
}

// world is a binder whose DNS says ldap.acme.test is a public address, and
// whose dial lands on the test directory wherever that address was meant to go.
type world struct {
	binder *passthrough.Binder
	dialed []string
}

func newWorld(t *testing.T, dir *ldaptest.Server) *world {
	t.Helper()
	w := &world{}
	w.binder = &passthrough.Binder{
		Resolver: resolver{ldaptest.Host: {publicIP}},
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			w.dialed = append(w.dialed, address)
			return (&net.Dialer{}).DialContext(ctx, network, dir.Addr)
		},
		DialTimeout:  time.Second,
		OpTimeout:    2 * time.Second,
		TotalTimeout: 5 * time.Second,
	}
	return w
}

func settingsFor(dir *ldaptest.Server, mode string) passthrough.Settings {
	port := 636
	if mode == passthrough.TLSModeStartTLS {
		port = 389
	}
	return passthrough.Settings{
		Host:       ldaptest.Host,
		Port:       port,
		TLSMode:    mode,
		CAPem:      dir.CAPem,
		SearchBase: "dc=acme,dc=test",
		UserFilter: "(mail={email})",
		BindDN:     ldaptest.ServiceDN,
		BindSecret: ldaptest.ServiceSecret,
	}
}

func people() []ldaptest.Person {
	return []ldaptest.Person{
		{DN: adaDN, Mail: adaMail, Password: adaPass},
		{DN: "uid=bob,ou=people,dc=acme,dc=test", Mail: "bob@acme.test", Password: "bob-pass"},
		// Two entries for one address: a filter that is not specific enough.
		{DN: "uid=twin1,ou=people,dc=acme,dc=test", Mail: "twin@acme.test", Password: "twin1"},
		{DN: "uid=twin2,ou=people,dc=acme,dc=test", Mail: "twin@acme.test", Password: "twin2"},
	}
}

func want(t *testing.T, got passthrough.Result, outcome passthrough.Outcome, reason string) {
	t.Helper()
	if got.Outcome != outcome || got.Reason != reason {
		t.Fatalf("result = %+v, want outcome %d reason %q", got, outcome, reason)
	}
}

// ── Refusals ─────────────────────────────────────────────────────────────

func TestAPrivateHostIsRefusedBeforeAnythingIsDialled(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	for _, host := range []string{
		"127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "0.0.0.0",
		"loop.acme.test", "meta.acme.test", "mixed.acme.test",
	} {
		w := newWorld(t, dir)
		w.binder.Resolver = resolver{
			"loop.acme.test":  {netip.MustParseAddr("127.0.0.1")},
			"meta.acme.test":  {netip.MustParseAddr("169.254.169.254")},
			"mixed.acme.test": {publicIP, netip.MustParseAddr("192.168.1.1")},
		}
		s := settingsFor(dir, passthrough.TLSModeLDAPS)
		s.Host = host
		want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonHostBlocked)
		if len(w.dialed) != 0 {
			t.Errorf("%s: dialled %v", host, w.dialed)
		}
	}
	if got := dir.Binds(); len(got) != 0 {
		t.Errorf("the directory saw binds %v", got)
	}
}

func TestADirectoryThatDoesNotResolveIsUnavailable(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	w := newWorld(t, dir)
	s := settingsFor(dir, passthrough.TLSModeLDAPS)
	s.Host = "nowhere.acme.test"
	want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonDNSFailed)
	if len(w.dialed) != 0 {
		t.Errorf("dialled %v", w.dialed)
	}
}

func TestTLSIsRequired(t *testing.T) {
	t.Run("plaintext is not a mode", func(t *testing.T) {
		dir := ldaptest.Start(t, ldaptest.Plain, people()...)
		for _, mode := range []string{"", "none", "plain", "ldap", "LDAPS", "start_tls"} {
			w := newWorld(t, dir)
			s := settingsFor(dir, mode)
			want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonBadSettings)
			if len(w.dialed) != 0 {
				t.Errorf("mode %q: dialled %v", mode, w.dialed)
			}
		}
		if len(dir.Binds()) != 0 {
			t.Errorf("binds reached the directory: %v", dir.Binds())
		}
	})

	t.Run("ldaps against a server that does not speak TLS", func(t *testing.T) {
		dir := ldaptest.Start(t, ldaptest.Plain, people()...)
		w := newWorld(t, dir)
		want(t, w.binder.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeLDAPS), adaMail, adaPass),
			passthrough.Unavailable, passthrough.ReasonTLSFailed)
		if len(dir.Binds()) != 0 {
			t.Errorf("the service secret reached a server without TLS: %v", dir.Binds())
		}
	})

	t.Run("starttls against a server that will not upgrade sends no bind", func(t *testing.T) {
		dir := ldaptest.Start(t, ldaptest.Plain, people()...)
		w := newWorld(t, dir)
		want(t, w.binder.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeStartTLS), adaMail, adaPass),
			passthrough.Unavailable, passthrough.ReasonTLSFailed)
		if len(dir.Binds()) != 0 {
			t.Errorf("a bind was sent in the clear: %v", dir.Binds())
		}
	})

	t.Run("an untrusted certificate is a refusal before any bind", func(t *testing.T) {
		dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
		other := ldaptest.Start(t, ldaptest.LDAPS)
		for name, ca := range map[string]string{
			"another CA pinned":              other.CAPem,
			"the system roots (self-signed)": "",
		} {
			w := newWorld(t, dir)
			s := settingsFor(dir, passthrough.TLSModeLDAPS)
			s.CAPem = ca
			want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonTLSFailed)
			if len(dir.Binds()) != 0 {
				t.Errorf("%s: the service secret reached an unverified server: %v", name, dir.Binds())
			}
		}
	})

	t.Run("a certificate for another name is a refusal", func(t *testing.T) {
		dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
		w := newWorld(t, dir)
		w.binder.Resolver = resolver{"other.acme.test": {publicIP}}
		s := settingsFor(dir, passthrough.TLSModeLDAPS)
		s.Host = "other.acme.test"
		want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonTLSFailed)
		if len(dir.Binds()) != 0 {
			t.Errorf("binds reached a server whose certificate is for another name: %v", dir.Binds())
		}
	})

	t.Run("a pinned CA that holds no certificate does not fall back to the system roots", func(t *testing.T) {
		dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
		w := newWorld(t, dir)
		s := settingsFor(dir, passthrough.TLSModeLDAPS)
		s.CAPem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"
		want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonBadSettings)
		if len(w.dialed) != 0 {
			t.Errorf("dialled %v", w.dialed)
		}
	})
}

func TestSettingsAreCheckedAgain(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	for name, mutate := range map[string]func(*passthrough.Settings){
		"no host":           func(s *passthrough.Settings) { s.Host = "" },
		"port 22":           func(s *passthrough.Settings) { s.Port = 22 },
		"port 0":            func(s *passthrough.Settings) { s.Port = 0 },
		"no search base":    func(s *passthrough.Settings) { s.SearchBase = "" },
		"no placeholder":    func(s *passthrough.Settings) { s.UserFilter = "(mail=ada@acme.test)" },
		"no service DN":     func(s *passthrough.Settings) { s.BindDN = "" },
		"no service secret": func(s *passthrough.Settings) { s.BindSecret = "" },
	} {
		w := newWorld(t, dir)
		s := settingsFor(dir, passthrough.TLSModeLDAPS)
		mutate(&s)
		want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonBadSettings)
		if len(w.dialed) != 0 {
			t.Errorf("%s: dialled %v", name, w.dialed)
		}
	}
}

func TestAnEmptyPasswordIsRefusedBeforeAnyNetworkCall(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	w := newWorld(t, dir)
	want(t, w.binder.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeLDAPS), adaMail, ""),
		passthrough.Rejected, passthrough.ReasonEmptyPassword)
	if len(w.dialed) != 0 {
		t.Errorf("dialled %v", w.dialed)
	}
}

func TestTheServiceAccountFailingIsOursToFixNotTheUsers(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	w := newWorld(t, dir)
	s := settingsFor(dir, passthrough.TLSModeLDAPS)
	s.BindSecret = "rotated-away"
	// Not invalidCredentials: the person did nothing wrong, and a mail client
	// told otherwise prompts them for a password that is fine.
	want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Unavailable, passthrough.ReasonServiceBindFailed)
	if got := dir.Binds(); len(got) != 1 || got[0] != ldaptest.ServiceDN {
		t.Errorf("binds = %v, want only the failed service bind", got)
	}
}

func TestOnlyExactlyOneEntryIsEverBoundAs(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	for name, tc := range map[string]struct {
		address, reason string
	}{
		"nobody has the address": {"nobody@acme.test", passthrough.ReasonUserNotFound},
		"two entries share it":   {"twin@acme.test", passthrough.ReasonAmbiguousEntry},
	} {
		w := newWorld(t, dir)
		before := len(dir.Binds())
		want(t, w.binder.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeLDAPS), tc.address, "twin1"),
			passthrough.Rejected, tc.reason)
		// Only the service bind: nobody was bound as.
		if got := dir.Binds()[before:]; len(got) != 1 || got[0] != ldaptest.ServiceDN {
			t.Errorf("%s: binds = %v, want only the service bind", name, got)
		}
	}
}

func TestAWrongPasswordIsRefused(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	w := newWorld(t, dir)
	want(t, w.binder.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeLDAPS), adaMail, "not-the-password"),
		passthrough.Rejected, passthrough.ReasonUserBindRejected)
	// Another person's password is a wrong password.
	want(t, w.binder.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeLDAPS), adaMail, "bob-pass"),
		passthrough.Rejected, passthrough.ReasonUserBindRejected)
}

func TestTheAddressCannotRewriteTheFilter(t *testing.T) {
	dir := ldaptest.Start(t, ldaptest.LDAPS, people()...)
	w := newWorld(t, dir)
	// Unescaped, "*" would match everybody (so: several entries, not none) and
	// ")(mail=*" would add a term of the caller's own.
	for _, address := range []string{"*", "x)(mail=*", "a*@acme.test"} {
		got := w.binder.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeLDAPS), address, "whatever")
		want(t, got, passthrough.Rejected, passthrough.ReasonUserNotFound)
	}
}

func TestADirectoryThatStopsAnsweringIsUnavailableAndBounded(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = c.Close() }) // accepted, never spoken to
		}
	}()
	dir := ldaptest.Start(t, ldaptest.LDAPS)
	b := &passthrough.Binder{
		Resolver: resolver{ldaptest.Host: {publicIP}},
		Dial: func(ctx context.Context, n, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, n, ln.Addr().String())
		},
		DialTimeout:  500 * time.Millisecond,
		OpTimeout:    500 * time.Millisecond,
		TotalTimeout: time.Second,
	}
	start := time.Now()
	got := b.Bind(context.Background(), settingsFor(dir, passthrough.TLSModeLDAPS), adaMail, adaPass)
	if got.Outcome != passthrough.Unavailable {
		t.Fatalf("result = %+v, want unavailable", got)
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("took %s: not bounded", time.Since(start))
	}
}

// ── The happy paths ──────────────────────────────────────────────────────

func TestACorrectPasswordIsVerifiedOverLDAPSAndStartTLS(t *testing.T) {
	for name, tc := range map[string]struct {
		mode ldaptest.Mode
		tls  string
	}{
		"ldaps":    {ldaptest.LDAPS, passthrough.TLSModeLDAPS},
		"starttls": {ldaptest.StartTLS, passthrough.TLSModeStartTLS},
	} {
		t.Run(name, func(t *testing.T) {
			dir := ldaptest.Start(t, tc.mode, people()...)
			w := newWorld(t, dir)
			s := settingsFor(dir, tc.tls)
			want(t, w.binder.Bind(context.Background(), s, adaMail, adaPass), passthrough.Verified, passthrough.ReasonVerified)

			// The vetted ADDRESS was dialled, not the name.
			if len(w.dialed) != 1 || w.dialed[0] != net.JoinHostPort(publicIP.String(), map[bool]string{true: "636", false: "389"}[tc.tls == passthrough.TLSModeLDAPS]) {
				t.Errorf("dialled %v", w.dialed)
			}
			if got := dir.Binds(); len(got) != 2 || got[0] != ldaptest.ServiceDN || got[1] != adaDN {
				t.Errorf("binds = %v, want the service account and then the person", got)
			}
			if dir.PlaintextOps() != 0 {
				t.Errorf("%d operations were sent before TLS", dir.PlaintextOps())
			}
		})
	}
}
