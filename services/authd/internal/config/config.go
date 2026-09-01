// Package config loads i10-authd's settings from the environment.
//
// Everything here is read once at startup and treated as immutable. There is
// no config file: authd runs as a sidecar in the Stalwart pod and its inputs
// come from the pod spec and from Doppler-synced secrets.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Listen is the address the LDAP server binds. It MUST stay on loopback:
	// authd performs no transport encryption and its only legitimate client is
	// Stalwart in the same pod. Binding it wider would expose an unauthenticated
	// path to Clerk password verification.
	Listen string

	// BaseDN roots every DN authd emits, e.g. "dc=i10,dc=tech".
	BaseDN string

	// ServiceBindDN / ServiceBindSecret are the credentials Stalwart uses for
	// its own bind. Stalwart needs this even in bindAuthentication mode, because
	// address validation and metadata lookups are not authenticated as any user.
	ServiceBindDN     string
	ServiceBindSecret string

	DatabaseURL string

	ClerkSecretKey string
	ClerkBaseURL   string
	ClerkTimeout   time.Duration

	// BindsPerMinute caps password verifications per identity. It exists to
	// protect the Clerk request budget (1000 req/10s across all of i10) from a
	// mail client stuck in a retry loop — NOT to protect users from Clerk's
	// account lockout, which we measured and confirmed the Backend API
	// verify_password endpoint does not trigger.
	BindsPerMinute int

	LogLevel string
}

func (c Config) Validate() error {
	var errs []error
	if c.BaseDN == "" {
		errs = append(errs, errors.New("AUTHD_BASE_DN is required"))
	}
	if c.ServiceBindDN == "" {
		errs = append(errs, errors.New("AUTHD_SERVICE_BIND_DN is required"))
	}
	if c.ServiceBindSecret == "" {
		errs = append(errs, errors.New("AUTHD_SERVICE_BIND_SECRET is required"))
	}
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("AUTHD_DATABASE_URL is required"))
	}
	if c.ClerkSecretKey == "" {
		errs = append(errs, errors.New("AUTHD_CLERK_SECRET_KEY is required"))
	}
	if !strings.HasPrefix(c.Listen, "127.0.0.1:") && !strings.HasPrefix(c.Listen, "[::1]:") &&
		!strings.HasPrefix(c.Listen, "localhost:") {
		errs = append(errs, fmt.Errorf(
			"AUTHD_LISTEN must be a loopback address, got %q: authd speaks plaintext LDAP and "+
				"delegates password checks, so it must not be reachable off-pod", c.Listen))
	}
	if c.BindsPerMinute <= 0 {
		errs = append(errs, errors.New("AUTHD_BINDS_PER_MINUTE must be positive"))
	}
	return errors.Join(errs...)
}

func Load() (Config, error) {
	c := Config{
		Listen:            env("AUTHD_LISTEN", "127.0.0.1:3893"),
		BaseDN:            env("AUTHD_BASE_DN", "dc=i10,dc=tech"),
		ServiceBindDN:     os.Getenv("AUTHD_SERVICE_BIND_DN"),
		ServiceBindSecret: os.Getenv("AUTHD_SERVICE_BIND_SECRET"),
		DatabaseURL:       os.Getenv("AUTHD_DATABASE_URL"),
		ClerkSecretKey:    os.Getenv("AUTHD_CLERK_SECRET_KEY"),
		ClerkBaseURL:      env("AUTHD_CLERK_BASE_URL", "https://api.clerk.com/v1"),
		LogLevel:          env("AUTHD_LOG_LEVEL", "info"),
	}

	var err error
	if c.ClerkTimeout, err = envDuration("AUTHD_CLERK_TIMEOUT", 5*time.Second); err != nil {
		return c, err
	}
	if c.BindsPerMinute, err = envInt("AUTHD_BINDS_PER_MINUTE", 30); err != nil {
		return c, err
	}
	return c, c.Validate()
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

func envDuration(key string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	v, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}
