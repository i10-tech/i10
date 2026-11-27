package main

import (
	"testing"
	"time"
)

func TestEnrollConfigValidation(t *testing.T) {
	valid := func() enrollConfig {
		return enrollConfig{
			Listen:         ":8080",
			APIURL:         "https://i10-api-ca-hooks.i10-prod.svc:3443",
			APICAFile:      "/etc/enrolld/hooks-ca/ca.crt",
			APIToken:       "secret-token",
			DeviceCABundle: "/etc/enrolld/device-ca/bundle.pem",
			ProfileURL:     "https://ca.i10.tech/enroll/apple/profile",
			SCEPURL:        "https://ca.i10.tech/scep/apple-scep",
			APITimeout:     10 * time.Second,
			MaxConcurrent:  16,
			LogLevel:       "info",
		}
	}
	if err := valid().validate(); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}

	for name, mutate := range map[string]func(*enrollConfig){
		"bad listen":           func(c *enrollConfig) { c.Listen = "8080" },
		"http API URL":         func(c *enrollConfig) { c.APIURL = "http://i10-api:3443" },
		"API URL with query":   func(c *enrollConfig) { c.APIURL = "https://i10-api:3443?x=1" },
		"missing API CA":       func(c *enrollConfig) { c.APICAFile = "" },
		"missing API token":    func(c *enrollConfig) { c.APIToken = "" },
		"newline in API token": func(c *enrollConfig) { c.APIToken = "a\nb" },
		"missing device CA":    func(c *enrollConfig) { c.DeviceCABundle = "" },
		"http profile URL":     func(c *enrollConfig) { c.ProfileURL = "http://ca.i10.tech/enroll/apple/profile" },
		"http SCEP URL":        func(c *enrollConfig) { c.SCEPURL = "http://ca.i10.tech/scep/apple-scep" },
		"timeout too short":    func(c *enrollConfig) { c.APITimeout = 100 * time.Millisecond },
		"timeout too long":     func(c *enrollConfig) { c.APITimeout = time.Minute },
		"max concurrent zero":  func(c *enrollConfig) { c.MaxConcurrent = 0 },
		"max concurrent huge":  func(c *enrollConfig) { c.MaxConcurrent = 500 },
	} {
		t.Run(name, func(t *testing.T) {
			c := valid()
			mutate(&c)
			if err := c.validate(); err == nil {
				t.Fatalf("%s: accepted", name)
			}
		})
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	t.Setenv("ENROLLD_LISTEN", "")
	t.Setenv("ENROLLD_API_URL", "")
	t.Setenv("ENROLLD_API_CA_FILE", "/etc/enrolld/hooks-ca/ca.crt")
	t.Setenv("ENROLLD_API_TOKEN", "tok")
	t.Setenv("ENROLLD_DEVICE_CA_BUNDLE", "/etc/enrolld/device-ca/bundle.pem")
	t.Setenv("ENROLLD_PROFILE_URL", "")
	t.Setenv("ENROLLD_SCEP_URL", "")
	t.Setenv("ENROLLD_API_TIMEOUT", "")
	t.Setenv("ENROLLD_MAX_CONCURRENT", "")

	c, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if c.Listen != defaultListen || c.APIURL != defaultAPIURL ||
		c.ProfileURL != defaultProfileURL || c.SCEPURL != defaultSCEPURL ||
		c.APITimeout != defaultAPITimeout || c.MaxConcurrent != defaultMaxConcurrent {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}
