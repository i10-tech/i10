package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/acmed"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

const (
	defaultListen          = ":8080"
	defaultBaseURL         = acmed.DefaultBaseURL
	defaultPrefix          = acmed.DefaultPrefix
	defaultEnrollctlURL    = "https://i10-enrollctl.i10-prod.svc:3443"
	defaultRedisUser       = "acmed"
	defaultUpstreamTimeout = 10 * time.Second
	defaultMaxOrders       = 20
)

type acmedConfig struct {
	Listen          string
	BaseURL         string
	Prefix          string
	RedisURL        string
	RedisUser       string
	RedisPassword   string
	EnrollctlURL    string
	EnrollctlCAFile string
	EnrollctlToken  string
	// NonceKeys is ACMED_NONCE_KEYS, the `<kid>:<base64>` ring that MACs the
	// stateless Replay-Nonces and account URLs (the first key signs, every key
	// verifies).
	NonceKeys *enrolltoken.Ring
	// PathKeys is ENROLL_ACME_PATH_KEYS, the ring enrollctl signs each Mac's
	// directory path token with; acmed only verifies. It mints nothing: a
	// forged token opens order creation for one serial, and finalize still
	// needs Apple's attestation and enrollctl's OU permit.
	PathKeys           *enrolltoken.Ring
	UpstreamTimeout    time.Duration
	MaxOrdersPerDevice int
	LogLevel           string
}

func loadConfig() (acmedConfig, error) {
	c := acmedConfig{
		Listen:             envOr("ACMED_LISTEN", defaultListen),
		BaseURL:            envOr("ACMED_BASE_URL", defaultBaseURL),
		Prefix:             envOr("ACMED_PREFIX", defaultPrefix),
		RedisURL:           strings.TrimSpace(os.Getenv("ENROLL_REDIS_URL")),
		RedisUser:          envOr("ENROLL_REDIS_USER", defaultRedisUser),
		RedisPassword:      os.Getenv("ENROLL_REDIS_PASSWORD"),
		EnrollctlURL:       envOr("ACMED_ENROLLCTL_URL", defaultEnrollctlURL),
		EnrollctlCAFile:    strings.TrimSpace(os.Getenv("ACMED_ENROLLCTL_CA_FILE")),
		EnrollctlToken:     strings.TrimSpace(os.Getenv("ACMED_ENROLLCTL_TOKEN")),
		UpstreamTimeout:    defaultUpstreamTimeout,
		MaxOrdersPerDevice: defaultMaxOrders,
		LogLevel:           envOr("ACMED_LOG_LEVEL", "info"),
	}
	if v := strings.TrimSpace(os.Getenv("ACMED_UPSTREAM_TIMEOUT")); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d < time.Second || d > 30*time.Second {
			return c, errors.New("ACMED_UPSTREAM_TIMEOUT must be 1s..30s")
		}
		c.UpstreamTimeout = d
	}
	if v := strings.TrimSpace(os.Getenv("ACMED_MAX_ORDERS_PER_DEVICE")); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 1000 {
			return c, errors.New("ACMED_MAX_ORDERS_PER_DEVICE must be 1..1000")
		}
		c.MaxOrdersPerDevice = n
	}
	ring, err := enrolltoken.ParseNonEmptyRing("ACMED_NONCE_KEYS", os.Getenv("ACMED_NONCE_KEYS"))
	if err != nil {
		return c, err
	}
	c.NonceKeys = ring
	if c.PathKeys, err = enrolltoken.ParseNonEmptyRing("ENROLL_ACME_PATH_KEYS", os.Getenv("ENROLL_ACME_PATH_KEYS")); err != nil {
		return c, err
	}
	if err := c.validate(); err != nil {
		return c, err
	}
	return c, nil
}

func (c acmedConfig) validate() error {
	for name, raw := range map[string]string{
		"ACMED_BASE_URL":      c.BaseURL,
		"ACMED_ENROLLCTL_URL": c.EnrollctlURL,
	} {
		u, err := url.Parse(raw)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return fmt.Errorf("%s must be a valid https:// URL", name)
		}
	}
	if !strings.HasPrefix(c.Prefix, "/") || len(c.Prefix) < 2 {
		return errors.New("ACMED_PREFIX must start with /")
	}
	if c.RedisURL == "" {
		return errors.New("ENROLL_REDIS_URL is required")
	}
	if c.RedisPassword == "" {
		return errors.New("ENROLL_REDIS_PASSWORD is required")
	}
	if c.EnrollctlCAFile == "" {
		return errors.New("ACMED_ENROLLCTL_CA_FILE is required")
	}
	if len(c.EnrollctlToken) < 16 {
		return errors.New("ACMED_ENROLLCTL_TOKEN is required (at least 16 chars)")
	}
	return nil
}

func envOr(name, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		return v
	}
	return fallback
}
