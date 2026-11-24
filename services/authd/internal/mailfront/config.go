package mailfront

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/bindtoken"
	"github.com/i10-tech/i10/services/authd/internal/config"
)

// Config is the front's settings, from the environment.
//
// ⚠ THERE IS NO CLERK KEY, NO API SECRET AND NO LDAP SECRET HERE, AND THERE MUST
// NEVER BE. This process parses bytes from anyone on the internet before they
// have signed in. Whatever it can read, a bug in it can leak.
type Config struct {
	// ListenIPs are the pod's own addresses (status.podIPs), never a wildcard:
	// Stalwart holds 127.0.0.1 on the same ports, and a wildcard bind would take
	// loopback too.
	ListenIPs []netip.Addr
	IMAPPort  int
	SMTPPort  int

	// IMAPUpstream and SMTPUpstream are Stalwart's loopback listeners.
	IMAPUpstream string
	SMTPUpstream string

	CertFile, KeyFile string
	DatabaseURL       string

	MaxConns, MaxPreAuth, MaxPreAuthPerIP int
	PreAuthTimeout                        time.Duration
	SweepInterval                         time.Duration
	PassthroughMaxAge                     time.Duration
	LogLevel                              string

	// BindTokenKey is MAILFRONT_BIND_TOKEN_KEY, "<id>:<base64>", the key the
	// front signs every forwarded sign-in's token with (internal/bindtoken).
	// ⚠ A MISSING OR BROKEN KEY IS NOT A STARTUP FAILURE: main logs it, and the
	// front answers every sign-in as temporarily unavailable. A front that exits
	// takes the pod, and this node's JMAP, out of the Service.
	BindTokenKey    *bindtoken.Key
	BindTokenKeyErr error
}

// LoadConfig reads MAILFRONT_* from the environment.
func LoadConfig() (Config, error) {
	c := Config{
		IMAPUpstream: config.Env("MAILFRONT_IMAP_UPSTREAM", "127.0.0.1:993"),
		SMTPUpstream: config.Env("MAILFRONT_SMTP_UPSTREAM", "127.0.0.1:465"),
		CertFile:     config.Env("MAILFRONT_TLS_CERT_FILE", "/etc/mailfront/tls/tls.crt"),
		KeyFile:      config.Env("MAILFRONT_TLS_KEY_FILE", "/etc/mailfront/tls/tls.key"),
		DatabaseURL:  os.Getenv("MAILFRONT_DATABASE_URL"),
		LogLevel:     config.Env("MAILFRONT_LOG_LEVEL", "info"),
	}
	for _, raw := range strings.FieldsFunc(os.Getenv("MAILFRONT_LISTEN_IPS"), func(r rune) bool { return r == ',' || r == ' ' }) {
		ip, err := netip.ParseAddr(raw)
		if err != nil {
			return c, fmt.Errorf("MAILFRONT_LISTEN_IPS: %w", err)
		}
		c.ListenIPs = append(c.ListenIPs, ip.Unmap())
	}
	var err error
	for _, f := range []struct {
		key string
		def int
		dst *int
	}{
		{"MAILFRONT_IMAP_PORT", 993, &c.IMAPPort},
		{"MAILFRONT_SMTP_PORT", 465, &c.SMTPPort},
		{"MAILFRONT_MAX_CONNECTIONS", 6000, &c.MaxConns},
		{"MAILFRONT_MAX_PREAUTH", 2000, &c.MaxPreAuth},
		{"MAILFRONT_MAX_PREAUTH_PER_IP", 32, &c.MaxPreAuthPerIP},
	} {
		if *f.dst, err = config.EnvInt(f.key, f.def); err != nil {
			return c, err
		}
	}
	if c.PreAuthTimeout, err = config.EnvDuration("MAILFRONT_PREAUTH_TIMEOUT", DefaultLimits.PreAuth); err != nil {
		return c, err
	}
	if c.SweepInterval, err = config.EnvDuration("MAILFRONT_SWEEP_INTERVAL", time.Second); err != nil {
		return c, err
	}
	if c.PassthroughMaxAge, err = config.EnvDuration("MAILFRONT_PASSTHROUGH_MAX_AGE", DefaultPassthroughMaxAge); err != nil {
		return c, err
	}
	if raw := os.Getenv("MAILFRONT_BIND_TOKEN_KEY"); raw == "" {
		c.BindTokenKeyErr = errors.New("MAILFRONT_BIND_TOKEN_KEY is not set")
	} else if k, kerr := bindtoken.ParseKey(raw); kerr != nil {
		c.BindTokenKeyErr = fmt.Errorf("MAILFRONT_BIND_TOKEN_KEY: %w", kerr)
	} else {
		c.BindTokenKey = &k
	}
	return c, c.Validate()
}

// Validate refuses a configuration that would bind the wrong thing or never
// close a revoked session in time.
func (c Config) Validate() error {
	var errs []error
	if len(c.ListenIPs) == 0 {
		errs = append(errs, errors.New("MAILFRONT_LISTEN_IPS is required (the pod's status.podIPs)"))
	}
	for _, ip := range c.ListenIPs {
		if ip.IsUnspecified() || ip.IsLoopback() {
			errs = append(errs, fmt.Errorf(
				"MAILFRONT_LISTEN_IPS has %s: the front binds the pod's own addresses, never a wildcard or "+
					"loopback, which is where Stalwart listens on the same ports", ip))
		}
	}
	for name, up := range map[string]string{"MAILFRONT_IMAP_UPSTREAM": c.IMAPUpstream, "MAILFRONT_SMTP_UPSTREAM": c.SMTPUpstream} {
		host, _, err := net.SplitHostPort(up)
		ip, perr := netip.ParseAddr(host)
		if err != nil || perr != nil || !ip.IsLoopback() {
			errs = append(errs, fmt.Errorf("%s must be a loopback address and port, got %q: the PROXY header "+
				"is trusted only from loopback", name, up))
		}
	}
	if c.DatabaseURL == "" {
		errs = append(errs, errors.New("MAILFRONT_DATABASE_URL is required"))
	}
	if c.IMAPPort <= 0 || c.IMAPPort > 65535 || c.SMTPPort <= 0 || c.SMTPPort > 65535 {
		errs = append(errs, errors.New("MAILFRONT_IMAP_PORT and MAILFRONT_SMTP_PORT must be ports"))
	}
	if c.MaxConns <= 0 || c.MaxPreAuth <= 0 || c.MaxPreAuthPerIP <= 0 {
		errs = append(errs, errors.New("MAILFRONT_MAX_* must be positive"))
	}
	if c.PreAuthTimeout < 10*time.Second || c.PreAuthTimeout > 10*time.Minute {
		errs = append(errs, fmt.Errorf("MAILFRONT_PREAUTH_TIMEOUT is %s: keep it between 10s and 10m", c.PreAuthTimeout))
	}
	if c.SweepInterval < 200*time.Millisecond || c.SweepInterval > 10*time.Second {
		// The poll interval IS the revocation window for open connections (the
		// change-driven poll, Sweeper.Poll; the full sweep is once a minute).
		errs = append(errs, fmt.Errorf("MAILFRONT_SWEEP_INTERVAL is %s: keep it between 200ms and 10s; it is how "+
			"long a revoked account's open connections survive", c.SweepInterval))
	}
	if c.PassthroughMaxAge < time.Minute || c.PassthroughMaxAge > 24*time.Hour {
		// It IS the window for a revocation in a company's directory, which i10
		// never sees; there is no "off".
		errs = append(errs, fmt.Errorf("MAILFRONT_PASSTHROUGH_MAX_AGE is %s: keep it between 1m and 24h; it is how "+
			"long a person disabled in their company's directory keeps an open mail session", c.PassthroughMaxAge))
	}
	return errors.Join(errs...)
}
