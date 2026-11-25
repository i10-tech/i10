// Package config loads i10-authd's settings from the environment.
//
// Everything here is read once at startup and treated as immutable. There is
// no config file: authd runs as a sidecar in the Stalwart pod and its inputs
// come from the pod spec and from Doppler-synced secrets.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/verify"
)

// maxCredCacheTTL is the ceiling Validate enforces on CredCacheTTL.
const maxCredCacheTTL = 3 * time.Hour

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

	// ClerkTimeout bounds one verify_password call. Each verifier has its own
	// timeout; this is Clerk's. Past verify.MaxTimeout the answer would arrive
	// after Stalwart has stopped listening, so Validate refuses it.
	ClerkTimeout time.Duration

	// BindsPerMinute caps password verifications per identity. It exists to
	// protect the Clerk request budget (1000 req/10s across all of i10) from a
	// mail client stuck in a retry loop - NOT to protect users from Clerk's
	// account lockout, which we measured and confirmed the Backend API
	// verify_password endpoint does not trigger.
	BindsPerMinute int

	// CredCacheTTL is how long a VERIFIED password is remembered, so that a
	// mail client opening several connections at once pays for one provider call
	// rather than one per connection, and a client that reconnects all day pays
	// for a handful. Zero disables the cache entirely.
	//
	// ⚠ IT IS ALSO THE LONGEST A REVOCATION NOBODY SIGNALLED STAYS LIVE, and two
	// hours is long enough to matter. It is defensible only because nearly every
	// revocation IS signalled, instantly, without waiting for it: the projection
	// active check runs before the cache, `clerk_updated_at` moves on any change
	// in Clerk, and `credential_epoch` is raised by the API for the rest. Read the
	// package comment in internal/credcache before changing it - this is a
	// security decision, not a tuning knob.
	CredCacheTTL time.Duration

	// APIURL and APISecret are where authd fetches a managed account's LDAP
	// pass-through settings (#344): `POST <APIURL>/internal/authd/passthrough`,
	// authenticated by APISecret (the API's `AUTHD_API_SECRET`).
	//
	// ⚠ BOTH OR NEITHER. With neither, there is no pass-through and a managed
	// account's bind is refused - it is never sent to Clerk instead.
	APIURL     string
	APISecret  string
	APITimeout time.Duration

	// BindTokenKeys is AUTHD_BIND_TOKEN_KEYS, the mail front's keys as
	// "<id>:<base64>,..." (internal/bindtoken). Read by main, not validated here:
	// ⚠ A MISSING OR BROKEN VALUE IS NOT A STARTUP FAILURE. authd starts, refuses
	// every person bind and says why, and keeps serving the service bind and
	// search, which Stalwart's delivery needs.
	BindTokenKeys string

	// MailDeviceCodeKeys is MAIL_DEVICE_CODE_KEYS, the keys mail device codes are
	// hashed under, "<id>:<base64>,..." (internal/devicecode). The API mints with
	// one and authd verifies with all; the mail front never holds them. Read by
	// main, not validated here: ⚠ A MISSING OR BROKEN VALUE IS NOT A STARTUP
	// FAILURE. authd starts, answers every device bind unavailable and says why,
	// and every password bind works as before.
	MailDeviceCodeKeys string

	// MacSMTPSameAddress is AUTHD_MAC_SMTP_SAME_ADDRESS (default true): a Mac's
	// SMTP bind requires a recent certificate-verified IMAP session from the
	// same /32 or /64. Set false (in lockstep with MAILFRONT_MAC_SMTP_SAME_ADDRESS)
	// to drop the address match if real dual-stack networks split IMAP and SMTP.
	MacSMTPSameAddress bool

	LogLevel string
}

// MinAPISecretLength matches the API's own check on AUTHD_API_SECRET.
const MinAPISecretLength = 32

// PassthroughConfigured reports whether managed accounts can be served.
func (c Config) PassthroughConfigured() bool { return c.APIURL != "" && c.APISecret != "" }

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
	if c.CredCacheTTL < 0 {
		errs = append(errs, errors.New("AUTHD_CRED_CACHE_TTL must not be negative"))
	}
	if c.CredCacheTTL > maxCredCacheTTL {
		// A guard rather than a preference. Hours is already a policy statement
		// about how long an unsignalled revocation stays live, and it was only
		// agreed because epoch invalidation makes the signalled ones instant.
		// Past three hours the timer is doing real security work again, which
		// does not belong in an environment variable nobody reviews.
		errs = append(errs, fmt.Errorf(
			"AUTHD_CRED_CACHE_TTL is %s: a verified-password cache longer than %s is how "+
				"a revoked credential keeps working; change the code and say why",
			c.CredCacheTTL, maxCredCacheTTL))
	}
	if c.ClerkTimeout <= 0 || c.ClerkTimeout > verify.MaxTimeout {
		errs = append(errs, fmt.Errorf(
			"AUTHD_CLERK_TIMEOUT is %s: it must be positive and at most %s, or authd would "+
				"answer after Stalwart has stopped listening (its directory timeout is 15s)",
			c.ClerkTimeout, verify.MaxTimeout))
	}
	if (c.APIURL == "") != (c.APISecret == "") {
		errs = append(errs, errors.New(
			"AUTHD_API_URL and AUTHD_API_SECRET go together: set both for LDAP pass-through, or neither"))
	}
	if c.APIURL != "" {
		if u, err := url.Parse(c.APIURL); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			errs = append(errs, errors.New("AUTHD_API_URL must be an http or https URL"))
		}
	}
	if c.APISecret != "" && len(c.APISecret) < MinAPISecretLength {
		errs = append(errs, fmt.Errorf("AUTHD_API_SECRET must be at least %d characters", MinAPISecretLength))
	}
	if c.PassthroughConfigured() && (c.APITimeout <= 0 || c.APITimeout > verify.MaxTimeout) {
		// The settings fetch runs inside the pass-through verifier's own timeout,
		// so one that could outlast verify.MaxTimeout would be cut off by it.
		errs = append(errs, fmt.Errorf(
			"AUTHD_API_TIMEOUT is %s: it must be positive and at most %s", c.APITimeout, verify.MaxTimeout))
	}
	return errors.Join(errs...)
}

func Load() (Config, error) {
	c := Config{
		Listen:            Env("AUTHD_LISTEN", "127.0.0.1:3893"),
		BaseDN:            Env("AUTHD_BASE_DN", "dc=i10,dc=tech"),
		ServiceBindDN:     os.Getenv("AUTHD_SERVICE_BIND_DN"),
		ServiceBindSecret: os.Getenv("AUTHD_SERVICE_BIND_SECRET"),
		DatabaseURL:       os.Getenv("AUTHD_DATABASE_URL"),
		ClerkSecretKey:    os.Getenv("AUTHD_CLERK_SECRET_KEY"),
		ClerkBaseURL:      Env("AUTHD_CLERK_BASE_URL", "https://api.clerk.com/v1"),
		APIURL:            Env("AUTHD_API_URL", ""),
		APISecret:         os.Getenv("AUTHD_API_SECRET"),
		BindTokenKeys:     os.Getenv("AUTHD_BIND_TOKEN_KEYS"),
		// No AUTHD_ prefix: the API reads the same variable to mint.
		MailDeviceCodeKeys: os.Getenv("MAIL_DEVICE_CODE_KEYS"),
		LogLevel:           Env("AUTHD_LOG_LEVEL", "info"),
	}

	var err error
	if c.ClerkTimeout, err = EnvDuration("AUTHD_CLERK_TIMEOUT", 5*time.Second); err != nil {
		return c, err
	}
	if c.BindsPerMinute, err = EnvInt("AUTHD_BINDS_PER_MINUTE", 30); err != nil {
		return c, err
	}
	if c.APITimeout, err = EnvDuration("AUTHD_API_TIMEOUT", 5*time.Second); err != nil {
		return c, err
	}
	if c.CredCacheTTL, err = EnvDuration("AUTHD_CRED_CACHE_TTL", 2*time.Hour); err != nil {
		return c, err
	}
	if c.MacSMTPSameAddress, err = EnvBool("AUTHD_MAC_SMTP_SAME_ADDRESS", true); err != nil {
		return c, err
	}
	return c, c.Validate()
}

// Env reads a trimmed variable, or fallback when it is unset or blank. The
// mail front loads its own settings with the same helpers.
func Env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// EnvBool reads a boolean variable, or fallback when it is unset or blank.
func EnvBool(key string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s: %w", key, err)
	}
	return v, nil
}

// EnvInt reads an integer variable, or fallback when it is unset.
func EnvInt(key string, fallback int) (int, error) {
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

// EnvDuration reads a Go duration variable, or fallback when it is unset.
func EnvDuration(key string, fallback time.Duration) (time.Duration, error) {
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
