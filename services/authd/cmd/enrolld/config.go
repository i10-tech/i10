package main

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/config"
)

const (
	defaultListen        = ":8080"
	defaultAPIURL        = "https://i10-api-ca-hooks.i10-prod.svc:3443"
	defaultProfileURL    = "https://ca.i10.tech/enroll/apple/profile"
	defaultSCEPURL       = "https://ca.i10.tech/scep/apple-scep"
	defaultAPITimeout    = 10 * time.Second
	defaultMaxConcurrent = 16
)

type enrollConfig struct {
	Listen         string
	APIURL         string
	APICAFile      string
	APIToken       string
	DeviceCABundle string
	ProfileURL     string
	SCEPURL        string
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
		ProfileURL:     config.Env("ENROLLD_PROFILE_URL", defaultProfileURL),
		SCEPURL:        config.Env("ENROLLD_SCEP_URL", defaultSCEPURL),
		LogLevel:       config.Env("ENROLLD_LOG_LEVEL", "info"),
	}
	var err error
	if c.APITimeout, err = config.EnvDuration("ENROLLD_API_TIMEOUT", defaultAPITimeout); err != nil {
		return c, err
	}
	if c.MaxConcurrent, err = config.EnvInt("ENROLLD_MAX_CONCURRENT", defaultMaxConcurrent); err != nil {
		return c, err
	}
	return c, c.validate()
}

func (c enrollConfig) validate() error {
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
	if err := validateHTTPSURL("ENROLLD_PROFILE_URL", c.ProfileURL); err != nil {
		errs = append(errs, err)
	}
	if err := validateHTTPSURL("ENROLLD_SCEP_URL", c.SCEPURL); err != nil {
		errs = append(errs, err)
	}
	if c.APITimeout < time.Second || c.APITimeout > 30*time.Second {
		errs = append(errs, fmt.Errorf("ENROLLD_API_TIMEOUT is %s: keep it between 1s and 30s", c.APITimeout))
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
