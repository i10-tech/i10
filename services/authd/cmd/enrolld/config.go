package main

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

const (
	defaultListen        = ":8080"
	defaultAPIURL        = "https://i10-enrollctl.i10-prod.svc:3443"
	defaultAPITimeout    = 15 * time.Second
	defaultMaxConcurrent = 16
)

type enrollConfig struct {
	Listen         string
	APIURL         string
	APICAFile      string
	APIToken       string
	DeviceCABundle string
	EdgeHMACKey    string
	EdgeLinkKeys   *enrolltoken.Ring
	APITimeout     time.Duration
	MaxConcurrent  int
	LogLevel       string
}

func loadConfig() (enrollConfig, error) {
	c := enrollConfig{
		Listen:         config.Env("ENROLLD_LISTEN", defaultListen),
		APIURL:         strings.TrimRight(config.Env("ENROLLD_API_URL", defaultAPIURL), "/"),
		APICAFile:      config.Env("ENROLLD_API_CA_FILE", ""),
		APIToken:       config.Env("ENROLLD_API_TOKEN", ""),
		DeviceCABundle: config.Env("ENROLLD_DEVICE_CA_BUNDLE", ""),
		EdgeHMACKey:    config.Env("ENROLL_EDGE_HMAC_KEY", ""),
		LogLevel:       config.Env("ENROLLD_LOG_LEVEL", "info"),
	}
	var err error
	if c.APITimeout, err = config.EnvDuration("ENROLLD_API_TIMEOUT", defaultAPITimeout); err != nil {
		return c, err
	}
	if c.MaxConcurrent, err = config.EnvInt("ENROLLD_MAX_CONCURRENT", defaultMaxConcurrent); err != nil {
		return c, err
	}
	if err := c.validate(); err != nil {
		return c, err
	}
	return c, nil
}

func (c *enrollConfig) validate() error {
	var errs []error
	if _, port, err := net.SplitHostPort(c.Listen); err != nil || port == "" {
		errs = append(errs, fmt.Errorf("ENROLLD_LISTEN must be host:port or :port, got %q", c.Listen))
	}
	if err := validateHTTPSURL("ENROLLD_API_URL", c.APIURL); err != nil {
		errs = append(errs, err)
	}
	if c.APICAFile == "" {
		errs = append(errs, errors.New("ENROLLD_API_CA_FILE is required"))
	}
	if c.APIToken == "" || strings.ContainsAny(c.APIToken, "\r\n") {
		errs = append(errs, errors.New("ENROLLD_API_TOKEN is required and must not contain line breaks"))
	}
	if c.DeviceCABundle == "" {
		errs = append(errs, errors.New("ENROLLD_DEVICE_CA_BUNDLE is required"))
	}
	if c.EdgeHMACKey == "" {
		errs = append(errs, errors.New("ENROLL_EDGE_HMAC_KEY is required"))
	} else {
		ring, err := enrolltoken.ParseNonEmptyRing("ENROLL_EDGE_HMAC_KEY", c.EdgeHMACKey)
		if err != nil {
			errs = append(errs, fmt.Errorf("ENROLL_EDGE_HMAC_KEY: %w", err))
		} else {
			c.EdgeLinkKeys = ring
		}
	}
	if c.APITimeout < time.Second || c.APITimeout > 35*time.Second {
		errs = append(errs, fmt.Errorf("ENROLLD_API_TIMEOUT is %s: keep it between 1s and 35s", c.APITimeout))
	}
	if c.MaxConcurrent < 1 || c.MaxConcurrent > 256 {
		errs = append(errs, fmt.Errorf("ENROLLD_MAX_CONCURRENT is %d: keep it between 1 and 256", c.MaxConcurrent))
	}
	return errors.Join(errs...)
}

func validateHTTPSURL(name, raw string) error {
	if raw == "" {
		return fmt.Errorf("%s is required", name)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("%s must be an https URL without query or fragment, got %q", name, raw)
	}
	return nil
}
