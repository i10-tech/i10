package passthrough

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/verify"
)

type scripted struct {
	result Result
	conn   string
	email  string
	pass   string
}

func (s *scripted) Bind(_ context.Context, conn, email, password string) Result {
	s.conn, s.email, s.pass = conn, email, password
	return s.result
}

type clerkStub struct{}

func (clerkStub) Name() string           { return "clerk" }
func (clerkStub) Timeout() time.Duration { return time.Second }
func (clerkStub) Budget() *verify.Budget { return nil }
func (clerkStub) Verify(context.Context, *projection.Account, string) (verify.Outcome, error) {
	return verify.Verified, nil
}

var quiet = slog.New(slog.NewTextHandler(io.Discard, nil))

func resolve(t *testing.T, r *ManagedResolver, a projection.Account) verify.Verifier {
	t.Helper()
	v, err := r.Resolve(context.Background(), &a)
	if err != nil || v == nil {
		t.Fatalf("Resolve = (%v, %v)", v, err)
	}
	return v
}

func TestTheResolverAsksWhoeverKeepsThePassword(t *testing.T) {
	dir := &scripted{}
	r := &ManagedResolver{Unmanaged: clerkStub{}, Directory: dir, Log: quiet}

	if got := resolve(t, r, projection.Account{ClerkUserID: "u"}); got.Name() != "clerk" {
		t.Errorf("an unmanaged account resolved to %q, want clerk", got.Name())
	}

	got := resolve(t, r, projection.Account{ClerkUserID: "u", Managed: true, ManagedConnection: "c1"})
	if got.Name() != NamePrefix+"c1" {
		t.Errorf("a managed account resolved to %q, want %q", got.Name(), NamePrefix+"c1")
	}
	// Two connections never share a name, or a cached credential from one would
	// answer for the other.
	other := resolve(t, r, projection.Account{ClerkUserID: "u", Managed: true, ManagedConnection: "c2"})
	if other.Name() == got.Name() {
		t.Errorf("connections c1 and c2 share the verifier name %q", got.Name())
	}
}

// ⚠ NEVER CLERK, whatever is missing. The alternative to the company's
// directory is a refusal.
func TestAManagedAccountWithNowhereToAskIsRefusedNotSentToClerk(t *testing.T) {
	cases := map[string]struct {
		r      *ManagedResolver
		a      projection.Account
		reason string
	}{
		"its connection is gone": {
			&ManagedResolver{Unmanaged: clerkStub{}, Directory: &scripted{}},
			projection.Account{Managed: true},
			ReasonManagedNoConnection,
		},
		"pass-through is not configured": {
			&ManagedResolver{Unmanaged: clerkStub{}},
			projection.Account{Managed: true, ManagedConnection: "c1"},
			ReasonNotConfigured,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			v := resolve(t, tc.r, tc.a)
			if v.Name() != tc.reason {
				t.Errorf("Name = %q, want %q", v.Name(), tc.reason)
			}
			if v.Budget() != nil {
				t.Error("a refusal has a budget: it asks nobody, so there is nothing to count")
			}
			if out, err := v.Verify(context.Background(), &tc.a, "anything"); out != verify.Rejected || err != nil {
				t.Errorf("Verify = (%v, %v), want Rejected", out, err)
			}
		})
	}
}

func TestTheVerifierMapsEveryDirectoryAnswerToTheTriState(t *testing.T) {
	for name, tc := range map[string]struct {
		result Result
		want   verify.Outcome
	}{
		"verified":                    {Result{Outcome: Verified, Reason: ReasonVerified}, verify.Verified},
		"a wrong password":            {Result{Outcome: Rejected, Reason: ReasonUserBindRejected}, verify.Rejected},
		"an address it does not know": {Result{Outcome: Rejected, Reason: ReasonUserNotFound}, verify.Rejected},
		"pass-through switched off":   {Result{Outcome: Rejected, Reason: ReasonPassthroughOff}, verify.Rejected},
		"the directory is down":       {Result{Outcome: Unavailable, Reason: ReasonDialFailed}, verify.Unavailable},
		"tls would not come up":       {Result{Outcome: Unavailable, Reason: ReasonTLSFailed}, verify.Unavailable},
		"our service account failed":  {Result{Outcome: Unavailable, Reason: ReasonServiceBindFailed}, verify.Unavailable},
		"the settings API is down":    {Result{Outcome: Unavailable, Reason: ReasonSettingsDown}, verify.Unavailable},
	} {
		t.Run(name, func(t *testing.T) {
			dir := &scripted{result: tc.result}
			r := &ManagedResolver{Unmanaged: clerkStub{}, Directory: dir, Log: quiet}
			a := projection.Account{ClerkUserID: "u", Email: "carol@acme.test", Managed: true, ManagedConnection: "c1"}

			out, err := resolve(t, r, a).Verify(context.Background(), &a, "hunter2-secret")
			if out != tc.want {
				t.Fatalf("outcome = %v, want %v", out, tc.want)
			}
			if dir.conn != "c1" || dir.email != "carol@acme.test" || dir.pass != "hunter2-secret" {
				t.Errorf("the directory was asked (%q, %q), want the account's connection and address", dir.conn, dir.email)
			}
			if tc.want == verify.Unavailable {
				if err == nil || !strings.Contains(err.Error(), tc.result.Reason) {
					t.Errorf("an unavailable answer should say why: %v", err)
				}
			}
			if err != nil && strings.Contains(err.Error(), "hunter2-secret") {
				t.Errorf("the password reached an error: %v", err)
			}
		})
	}
}

// Bind sizes its own deadline from Timeout and clamps it to verify.MaxTimeout;
// a verifier that asked for more would silently get less than it planned for.
func TestTheVerifierFitsInsideTheBindWindowAndCarriesTheDirectoryBudget(t *testing.T) {
	v := &Verifier{svc: &scripted{}, connection: "c1", log: quiet}
	if v.Timeout() <= 0 || v.Timeout() > verify.MaxTimeout {
		t.Errorf("Timeout = %s, want 0 < t <= %s", v.Timeout(), verify.MaxTimeout)
	}
	b := v.Budget()
	if b == nil || b.Max != 3 || b.Window != 15*time.Minute {
		t.Fatalf("Budget = %+v, want 3 per 15 minutes", b)
	}
	// A copy: a caller cannot widen the package's budget through it.
	b.Max = 99
	if FailureBudget.Max != 3 {
		t.Error("changing the budget a verifier returned changed the package's")
	}
}

// ⚠ SSO REQUIRED REFUSES THE CLERK PASSWORD, EXCEPT FOR THE PEOPLE SSO EXEMPTS.
// The refusal's name differs from Clerk's, which is what makes losing the
// exemption bite on the next bind: a password cached under "clerk" cannot match it.
func TestTheResolverRefusesARequiredDomainExceptForTheExempt(t *testing.T) {
	r := &ManagedResolver{Unmanaged: clerkStub{}, Directory: &scripted{}, Log: quiet}

	required := resolve(t, r, projection.Account{ClerkUserID: "u", SSORequired: true})
	if required.Name() != ReasonSSORequired {
		t.Fatalf("an unexempt account on a required domain resolved to %q, want %q", required.Name(), ReasonSSORequired)
	}
	exempt := resolve(t, r, projection.Account{ClerkUserID: "u", SSORequired: true, SSOExempt: true})
	if exempt.Name() != "clerk" {
		t.Fatalf("an exempt account on a required domain resolved to %q, want clerk", exempt.Name())
	}
	if exempt.Name() == required.Name() {
		t.Fatal("the refusal and Clerk share a name: a cached Clerk password would outlive the exemption")
	}

	// An account that is managed is answered by its directory whatever the flags say.
	managed := resolve(t, r, projection.Account{
		ClerkUserID: "u", Managed: true, ManagedConnection: "c1", SSORequired: true, SSOExempt: true,
	})
	if managed.Name() != NamePrefix+"c1" {
		t.Fatalf("a managed account resolved to %q, want its connection's verifier", managed.Name())
	}
}
