package config

import (
	"strings"
	"testing"
	"time"
)

func valid() Config {
	return Config{
		Listen:            "127.0.0.1:3893",
		BaseDN:            "dc=i10,dc=tech",
		ServiceBindDN:     "cn=stalwart,ou=services,dc=i10,dc=tech",
		ServiceBindSecret: "s3cret",
		DatabaseURL:       "postgres://localhost/i10",
		ClerkSecretKey:    "sk_test_x",
		ClerkTimeout:      5 * time.Second,
		BindsPerMinute:    30,
	}
}

func TestValidateAcceptsAGoodConfig(t *testing.T) {
	if err := valid().Validate(); err != nil {
		t.Fatalf("Validate() = %v", err)
	}
}

// The loopback guard is a security control, not a convenience. authd speaks
// plaintext LDAP and will verify any password it is handed against Clerk; off-pod
// reachability would make it an open oracle.
func TestValidateRejectsNonLoopbackListen(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:3893", ":3893", "10.0.0.5:3893", "[::]:3893"} {
		c := valid()
		c.Listen = addr
		err := c.Validate()
		if err == nil {
			t.Fatalf("Listen=%q accepted", addr)
		}
		if !strings.Contains(err.Error(), "loopback") {
			t.Errorf("Listen=%q gave an unhelpful error: %v", addr, err)
		}
	}
	for _, addr := range []string{"127.0.0.1:3893", "[::1]:3893", "localhost:3893"} {
		c := valid()
		c.Listen = addr
		if err := c.Validate(); err != nil {
			t.Errorf("Listen=%q rejected: %v", addr, err)
		}
	}
}

func TestValidateReportsEveryMissingField(t *testing.T) {
	err := Config{Listen: "127.0.0.1:3893", BindsPerMinute: 1}.Validate()
	if err == nil {
		t.Fatal("empty config accepted")
	}
	// errors.Join means one run surfaces every problem, rather than making the
	// operator fix them one restart at a time.
	for _, want := range []string{
		"AUTHD_BASE_DN", "AUTHD_SERVICE_BIND_DN", "AUTHD_SERVICE_BIND_SECRET",
		"AUTHD_DATABASE_URL", "AUTHD_CLERK_SECRET_KEY",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

func TestValidateRejectsNonPositiveRate(t *testing.T) {
	c := valid()
	c.BindsPerMinute = 0
	if err := c.Validate(); err == nil {
		t.Fatal("BindsPerMinute=0 accepted; that would deny every bind")
	}
}

// The cache is allowed to be long only because revocation does not wait for it.
// The ceiling is what stops a later edit quietly turning the timer back into the
// thing that decides how long a revoked credential works.
func TestCredCacheTTLCeiling(t *testing.T) {
	for _, ok := range []time.Duration{0, time.Minute, 2 * time.Hour, 3 * time.Hour} {
		c := valid()
		c.CredCacheTTL = ok
		if err := c.Validate(); err != nil {
			t.Errorf("CredCacheTTL=%s rejected: %v", ok, err)
		}
	}
	c := valid()
	c.CredCacheTTL = 3*time.Hour + time.Second
	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "AUTHD_CRED_CACHE_TTL") {
		t.Fatalf("CredCacheTTL above 3h accepted or unhelpful: %v", err)
	}
}

// A Clerk call that can outlast the operation deadline would be answered after
// Stalwart has given up on authd.
func TestClerkTimeoutMustFitInsideStalwartsWindow(t *testing.T) {
	for _, bad := range []time.Duration{0, -time.Second, 13 * time.Second, time.Minute} {
		c := valid()
		c.ClerkTimeout = bad
		err := c.Validate()
		if err == nil || !strings.Contains(err.Error(), "AUTHD_CLERK_TIMEOUT") {
			t.Errorf("ClerkTimeout=%s accepted or unhelpful: %v", bad, err)
		}
	}
	c := valid()
	c.ClerkTimeout = 12 * time.Second
	if err := c.Validate(); err != nil {
		t.Errorf("ClerkTimeout=12s rejected: %v", err)
	}
}

func TestDefaultCredCacheTTLIsTwoHours(t *testing.T) {
	t.Setenv("AUTHD_CRED_CACHE_TTL", "")
	t.Setenv("AUTHD_SERVICE_BIND_DN", "cn=stalwart,ou=services,dc=i10,dc=tech")
	t.Setenv("AUTHD_SERVICE_BIND_SECRET", "s")
	t.Setenv("AUTHD_DATABASE_URL", "postgres://localhost/i10")
	t.Setenv("AUTHD_CLERK_SECRET_KEY", "sk_test_x")
	c, err := Load()
	if err != nil {
		t.Fatalf("Load() = %v", err)
	}
	if c.CredCacheTTL != 2*time.Hour {
		t.Fatalf("default CredCacheTTL = %s, want 2h", c.CredCacheTTL)
	}
}
