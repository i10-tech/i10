package main

import (
	"encoding/base64"
	"testing"
	"time"
)

func testEdgeHMACKey() string {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	return "1:" + base64.StdEncoding.EncodeToString(key)
}

func TestEnrollConfigValidation(t *testing.T) {
	valid := func() enrollConfig {
		return enrollConfig{
			Listen:         ":8080",
			APIURL:         "https://i10-enrollctl.i10-prod.svc:3443",
			APICAFile:      "/etc/enrolld/hooks-ca/ca.crt",
			APIToken:       "secret-token",
			DeviceCABundle: "/etc/enrolld/device-ca/bundle.pem",
			EdgeHMACKey:    testEdgeHMACKey(),
			APITimeout:     10 * time.Second,
			MaxConcurrent:  16,
			LogLevel:       "info",
		}
	}
	c0 := valid()
	if err := c0.validate(); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
	if c0.EdgeLinkKeys == nil {
		t.Fatal("EdgeLinkKeys not parsed on valid config")
	}
	// 35 s lets enrolld outlast enrollctl's longest finish at the highest
	// ENROLLCTL_CALL_TIMEOUT.
	longest := valid()
	longest.APITimeout = 35 * time.Second
	if err := longest.validate(); err != nil {
		t.Fatalf("ENROLLD_API_TIMEOUT=35s refused: %v", err)
	}

	for name, mutate := range map[string]func(*enrollConfig){
		"bad listen":           func(c *enrollConfig) { c.Listen = "8080" },
		"http API URL":         func(c *enrollConfig) { c.APIURL = "http://i10-enrollctl:3443" },
		"API URL with query":   func(c *enrollConfig) { c.APIURL = "https://i10-enrollctl:3443?x=1" },
		"missing API CA":       func(c *enrollConfig) { c.APICAFile = "" },
		"missing API token":    func(c *enrollConfig) { c.APIToken = "" },
		"newline in API token": func(c *enrollConfig) { c.APIToken = "a\nb" },
		"missing device CA":    func(c *enrollConfig) { c.DeviceCABundle = "" },
		"missing edge key":     func(c *enrollConfig) { c.EdgeHMACKey = "" },
		"malformed edge key":   func(c *enrollConfig) { c.EdgeHMACKey = "not-a-key" },
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
	t.Setenv("ENROLL_EDGE_HMAC_KEY", testEdgeHMACKey())
	t.Setenv("ENROLLD_API_TIMEOUT", "")
	t.Setenv("ENROLLD_MAX_CONCURRENT", "")

	c, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if c.Listen != defaultListen || c.APIURL != defaultAPIURL ||
		c.APITimeout != defaultAPITimeout || c.MaxConcurrent != defaultMaxConcurrent ||
		c.EdgeLinkKeys == nil {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}
