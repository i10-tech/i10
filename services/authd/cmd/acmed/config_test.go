package main

import "testing"

func TestLoadAcmedConfig(t *testing.T) {
	setBase := func(t *testing.T) {
		t.Helper()
		t.Setenv("ENROLL_REDIS_URL", "redis://i10-enroll-redis.i10-prod.svc:6379")
		t.Setenv("ENROLL_REDIS_PASSWORD", "redis-password")
		t.Setenv("ACMED_NONCE_KEYS", "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
		t.Setenv("ENROLL_ACME_PATH_KEYS", "2:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=")
		t.Setenv("ACMED_ENROLLCTL_CA_FILE", "/etc/acmed/ca/ca.crt")
		t.Setenv("ACMED_ENROLLCTL_TOKEN", "0123456789abcdef0123456789abcdef")
	}

	t.Run("valid defaults", func(t *testing.T) {
		setBase(t)
		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.BaseURL != defaultBaseURL || cfg.Prefix != defaultPrefix || cfg.RedisUser != "acmed" {
			t.Fatalf("unexpected defaults: %+v", cfg)
		}
	})

	t.Run("non-https base URL refused", func(t *testing.T) {
		setBase(t)
		t.Setenv("ACMED_BASE_URL", "http://ca.i10.tech")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected error for http ACMED_BASE_URL")
		}
	})

	t.Run("missing nonce keys refused", func(t *testing.T) {
		setBase(t)
		t.Setenv("ACMED_NONCE_KEYS", "")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected error without ACMED_NONCE_KEYS")
		}
	})

	t.Run("missing path keys refused", func(t *testing.T) {
		setBase(t)
		t.Setenv("ENROLL_ACME_PATH_KEYS", "")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected error without ENROLL_ACME_PATH_KEYS")
		}
	})

	t.Run("order cap per device", func(t *testing.T) {
		setBase(t)
		t.Setenv("ACMED_MAX_ORDERS_PER_DEVICE", "7")
		if cfg, err := loadConfig(); err != nil || cfg.MaxOrdersPerDevice != 7 {
			t.Fatalf("loadConfig = (%d, %v), want 7", cfg.MaxOrdersPerDevice, err)
		}
	})

	t.Run("short bearer token refused", func(t *testing.T) {
		setBase(t)
		t.Setenv("ACMED_ENROLLCTL_TOKEN", "short")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected error for short bearer token")
		}
	})
}
