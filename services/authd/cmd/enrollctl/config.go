package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
	"github.com/i10-tech/i10/services/authd/internal/keyring"
)

const (
	defaultListen           = ":3443"
	defaultTLSCertFile      = "/etc/enrollctl/tls/tls.crt"
	defaultTLSKeyFile       = "/etc/enrollctl/tls/tls.key"
	defaultProfileCertFile  = "/etc/enrollctl/profile-signing/tls.crt"
	defaultProfileKeyFile   = "/etc/enrollctl/profile-signing/tls.key"
	defaultDeviceCACertFile = "/etc/enrollctl/device-ca-issuer/intermediate.crt"
	defaultDeviceCAKeyFile  = "/etc/enrollctl/device-ca-issuer/intermediate.key"
	defaultDeviceCABundle   = "/etc/enrollctl/device-ca-trust/bundle.pem"
	defaultProfileURL       = "https://ca.i10.tech/enroll/apple/profile"
	defaultSCEPURL          = "https://ca.i10.tech/scep/apple-scep"
	defaultACMEDirURL       = "https://ca.i10.tech/acme/apple/directory"
	defaultIMAPHost         = "mail.i10.tech"
	defaultIMAPPort         = 993
	defaultSMTPHost         = "mail.i10.tech"
	defaultSMTPPort         = 465
	defaultOrg              = "i10"
	defaultRedisUser        = "enrollctl"
)

type config struct {
	Listen           string
	TLSCertFile      string
	TLSKeyFile       string
	ProfileCertFile  string
	ProfileKeyFile   string
	DeviceCACertFile string
	DeviceCAKeyFile  string
	DeviceCABundle   string
	DatabaseURL      string
	RedisURL         string
	RedisUser        string
	RedisPassword    string
	EdgeLinkKeys     *enrolltoken.Ring
	ACMEPermitKeys   *enrolltoken.Ring
	ACMEPathKeys     *enrolltoken.Ring
	DeviceCodeKeys   keyring.Ring
	EnrolldTokens    [][]byte
	AcmedTokens      [][]byte
	ProfileURL       string
	SCEPURL          string
	ACMEDirectoryURL string
	IMAPHost         string
	IMAPPort         int
	SMTPHost         string
	SMTPPort         int
	Organization     string
	BatchMaxSize     int
	BatchMaxWait     time.Duration
	CallTimeout      time.Duration
	LogLevel         string
}

func loadConfig() (config, error) {
	c := config{
		Listen:           envOr("ENROLLCTL_LISTEN", defaultListen),
		TLSCertFile:      envOr("ENROLLCTL_TLS_CERT_FILE", defaultTLSCertFile),
		TLSKeyFile:       envOr("ENROLLCTL_TLS_KEY_FILE", defaultTLSKeyFile),
		ProfileCertFile:  envOr("ENROLLCTL_PROFILE_SIGNING_CERT_FILE", defaultProfileCertFile),
		ProfileKeyFile:   envOr("ENROLLCTL_PROFILE_SIGNING_KEY_FILE", defaultProfileKeyFile),
		DeviceCACertFile: envOr("ENROLLCTL_DEVICE_CA_CERT_FILE", defaultDeviceCACertFile),
		DeviceCAKeyFile:  envOr("ENROLLCTL_DEVICE_CA_KEY_FILE", defaultDeviceCAKeyFile),
		DeviceCABundle:   envOr("ENROLLCTL_DEVICE_CA_BUNDLE", defaultDeviceCABundle),
		DatabaseURL:      strings.TrimSpace(os.Getenv("ENROLLCTL_DATABASE_URL")),
		RedisURL:         strings.TrimSpace(os.Getenv("ENROLL_REDIS_URL")),
		RedisUser:        envOr("ENROLL_REDIS_USER", defaultRedisUser),
		RedisPassword:    os.Getenv("ENROLL_REDIS_PASSWORD"),
		ProfileURL:       envOr("ENROLLCTL_PROFILE_URL", defaultProfileURL),
		SCEPURL:          envOr("ENROLLCTL_SCEP_URL", defaultSCEPURL),
		ACMEDirectoryURL: envOr("ENROLLCTL_ACME_DIRECTORY_URL", defaultACMEDirURL),
		IMAPHost:         envOr("ENROLLCTL_IMAP_HOST", defaultIMAPHost),
		IMAPPort:         defaultIMAPPort,
		SMTPHost:         envOr("ENROLLCTL_SMTP_HOST", defaultSMTPHost),
		SMTPPort:         defaultSMTPPort,
		Organization:     envOr("ENROLLCTL_ORGANIZATION", defaultOrg),
		BatchMaxSize:     enrollctl.DefaultMaxBatch,
		BatchMaxWait:     enrollctl.DefaultMaxWait,
		CallTimeout:      enrollctl.DefaultCallTimeout,
		LogLevel:         envOr("ENROLLCTL_LOG_LEVEL", "info"),
	}

	var err error
	if v := strings.TrimSpace(os.Getenv("ENROLLCTL_IMAP_PORT")); v != "" {
		c.IMAPPort, err = parsePort("ENROLLCTL_IMAP_PORT", v)
		if err != nil {
			return c, err
		}
	}
	if v := strings.TrimSpace(os.Getenv("ENROLLCTL_SMTP_PORT")); v != "" {
		c.SMTPPort, err = parsePort("ENROLLCTL_SMTP_PORT", v)
		if err != nil {
			return c, err
		}
	}
	if v := strings.TrimSpace(os.Getenv("ENROLLCTL_BATCH_MAX_SIZE")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			return c, errors.New("ENROLLCTL_BATCH_MAX_SIZE must be 1..1000")
		}
		c.BatchMaxSize = n
	}
	if v := strings.TrimSpace(os.Getenv("ENROLLCTL_BATCH_MAX_WAIT")); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Millisecond || d > 500*time.Millisecond {
			return c, errors.New("ENROLLCTL_BATCH_MAX_WAIT must be 1ms..500ms")
		}
		c.BatchMaxWait = d
	}
	if v := strings.TrimSpace(os.Getenv("ENROLLCTL_CALL_TIMEOUT")); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Second || d >= enrollctl.MaxCallTimeout {
			return c, fmt.Errorf("ENROLLCTL_CALL_TIMEOUT must be at least 1s and below %s (the sealing marker must outlive its holder)", enrollctl.MaxCallTimeout)
		}
		c.CallTimeout = d
	}

	c.EdgeLinkKeys, err = enrolltoken.ParseNonEmptyRing("ENROLL_EDGE_HMAC_KEY", os.Getenv("ENROLL_EDGE_HMAC_KEY"))
	if err != nil {
		return c, err
	}
	c.ACMEPermitKeys, err = enrolltoken.ParseNonEmptyRing("ENROLLCTL_ACME_PERMIT_KEYS", os.Getenv("ENROLLCTL_ACME_PERMIT_KEYS"))
	if err != nil {
		return c, err
	}
	c.ACMEPathKeys, err = enrolltoken.ParseNonEmptyRing("ENROLL_ACME_PATH_KEYS", os.Getenv("ENROLL_ACME_PATH_KEYS"))
	if err != nil {
		return c, err
	}
	c.DeviceCodeKeys, err = keyring.ParseRing("MAIL_DEVICE_CODE_KEYS", os.Getenv("MAIL_DEVICE_CODE_KEYS"))
	if err != nil {
		return c, err
	}
	if len(c.DeviceCodeKeys) == 0 {
		return c, errors.New("MAIL_DEVICE_CODE_KEYS is required")
	}
	c.EnrolldTokens, err = parseSHA256HashList("ENROLLCTL_ENROLLD_TOKEN_HASHES", os.Getenv("ENROLLCTL_ENROLLD_TOKEN_HASHES"))
	if err != nil {
		return c, err
	}
	c.AcmedTokens, err = parseSHA256HashList("ENROLLCTL_ACMED_TOKEN_HASHES", os.Getenv("ENROLLCTL_ACMED_TOKEN_HASHES"))
	if err != nil {
		return c, err
	}
	for _, et := range c.EnrolldTokens {
		for _, at := range c.AcmedTokens {
			if bytes.Equal(et, at) {
				return c, errors.New("ENROLLCTL_ENROLLD_TOKEN_HASHES and ENROLLCTL_ACMED_TOKEN_HASHES must share no entry")
			}
		}
	}
	if err := c.validate(); err != nil {
		return c, err
	}
	return c, nil
}

func (c config) validate() error {
	if c.DatabaseURL == "" {
		return errors.New("ENROLLCTL_DATABASE_URL is required")
	}
	if c.RedisURL == "" {
		return errors.New("ENROLL_REDIS_URL is required")
	}
	if c.RedisPassword == "" {
		return errors.New("ENROLL_REDIS_PASSWORD is required")
	}
	for name, rawURL := range map[string]string{
		"ENROLLCTL_PROFILE_URL":        c.ProfileURL,
		"ENROLLCTL_SCEP_URL":           c.SCEPURL,
		"ENROLLCTL_ACME_DIRECTORY_URL": c.ACMEDirectoryURL,
	} {
		u, err := url.Parse(rawURL)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return fmt.Errorf("%s must be a valid https:// URL", name)
		}
	}
	// Each Mac's directory URL puts its path token before /directory.
	if u, _ := url.Parse(c.ACMEDirectoryURL); !strings.HasSuffix(u.Path, "/directory") || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("ENROLLCTL_ACME_DIRECTORY_URL must end in /directory, with no query or fragment")
	}
	return nil
}

// writeTimeout is the HTTP server's WriteTimeout: 15 s, or longer when
// CallTimeout lets a finish run past it, so a device that has minted and
// sealed still gets its profile.
func (c config) writeTimeout() time.Duration {
	return max(15*time.Second, enrollctl.MaxHandlerDuration(c.CallTimeout)+500*time.Millisecond)
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}

func parsePort(name, raw string) (int, error) {
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 65535 {
		return 0, fmt.Errorf("%s must be 1..65535", name)
	}
	return n, nil
}

func parseSHA256HashList(name, raw string) ([][]byte, error) {
	var out [][]byte
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if len(part) != 64 {
			return nil, fmt.Errorf("%s: each entry must be 64 lowercase hex characters", name)
		}
		b, err := hex.DecodeString(part)
		if err != nil || len(b) != 32 {
			return nil, fmt.Errorf("%s: invalid hex entry", name)
		}
		out = append(out, b)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: at least one SHA-256 hash is required", name)
	}
	return out, nil
}
