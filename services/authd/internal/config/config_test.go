package config

import (
	"strings"
	"testing"
)

func valid() Config {
	return Config{
		Listen:            "127.0.0.1:3893",
		BaseDN:            "dc=i10,dc=tech",
		ServiceBindDN:     "cn=stalwart,ou=services,dc=i10,dc=tech",
		ServiceBindSecret: "s3cret",
		DatabaseURL:       "postgres://localhost/i10",
		ClerkSecretKey:    "sk_test_x",
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
