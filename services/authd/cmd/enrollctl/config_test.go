package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
)

func TestLoadConfigValidationAndTokenOverlapRefusal(t *testing.T) {
	key := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", 32)))
	sum := func(s string) string {
		h := sha256.Sum256([]byte(s))
		return hex.EncodeToString(h[:])
	}

	setBase := func(t *testing.T) {
		t.Helper()
		t.Setenv("ENROLLCTL_DATABASE_URL", "postgres://enroll_writer:pw@127.0.0.1:5432/i10")
		t.Setenv("ENROLL_REDIS_URL", "redis://127.0.0.1:6379")
		t.Setenv("ENROLL_REDIS_PASSWORD", "redis-password")
		t.Setenv("ENROLL_EDGE_HMAC_KEY", "1:"+key)
		t.Setenv("ENROLLCTL_ACME_PERMIT_KEYS", "1:"+key)
		t.Setenv("ENROLL_ACME_PATH_KEYS", "2:"+key)
		t.Setenv("MAIL_DEVICE_CODE_KEYS", "1:"+key)
		t.Setenv("ENROLLCTL_ENROLLD_TOKEN_HASHES", sum("enrolld-token-1"))
		t.Setenv("ENROLLCTL_ACMED_TOKEN_HASHES", sum("acmed-token-1"))
	}

	t.Run("valid", func(t *testing.T) {
		setBase(t)
		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig valid: %v", err)
		}
		if cfg.Listen != defaultListen || cfg.BatchMaxSize != 200 {
			t.Fatalf("unexpected defaults: %+v", cfg)
		}
	})

	t.Run("overlapping bearer tokens refused", func(t *testing.T) {
		setBase(t)
		shared := sum("shared-token")
		t.Setenv("ENROLLCTL_ENROLLD_TOKEN_HASHES", sum("enrolld-token-1")+","+shared)
		t.Setenv("ENROLLCTL_ACMED_TOKEN_HASHES", shared)
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected error for overlapping bearer hashes")
		}
	})

	t.Run("missing ACME path keys refused", func(t *testing.T) {
		setBase(t)
		t.Setenv("ENROLL_ACME_PATH_KEYS", "")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected error without ENROLL_ACME_PATH_KEYS")
		}
	})

	t.Run("ACME directory URL must end in /directory", func(t *testing.T) {
		for _, bad := range []string{"https://ca.i10.tech/acme/apple", "https://ca.i10.tech/acme/apple/directory?x=1"} {
			setBase(t)
			t.Setenv("ENROLLCTL_ACME_DIRECTORY_URL", bad)
			if _, err := loadConfig(); err == nil {
				t.Fatalf("expected error for %q", bad)
			}
		}
	})

	// A marker holder can live CallTimeout + batch deadline (4s) + takenGrace
	// (1s) + seal (2s) + notice (0.5s), which must stay under the marker's 30s.
	t.Run("call timeout bounded by the sealing marker's life", func(t *testing.T) {
		setBase(t)
		below := enrollctl.MaxCallTimeout - time.Millisecond
		t.Setenv("ENROLLCTL_CALL_TIMEOUT", below.String())
		if cfg, err := loadConfig(); err != nil || cfg.CallTimeout != below {
			t.Fatalf("ENROLLCTL_CALL_TIMEOUT=%s = (%v, %v), want accepted", below, cfg.CallTimeout, err)
		}
		for _, bad := range []string{enrollctl.MaxCallTimeout.String(), "23s", "30s"} {
			t.Setenv("ENROLLCTL_CALL_TIMEOUT", bad)
			if _, err := loadConfig(); err == nil {
				t.Fatalf("ENROLLCTL_CALL_TIMEOUT=%s accepted (max %s)", bad, enrollctl.MaxCallTimeout)
			}
		}
		if enrollctl.MaxCallTimeout != 22500*time.Millisecond {
			t.Fatalf("MaxCallTimeout = %s, want 30s - 4s - 1s - 2s - 500ms", enrollctl.MaxCallTimeout)
		}
	})

	t.Run("non-https profile URL refused", func(t *testing.T) {
		setBase(t)
		t.Setenv("ENROLLCTL_PROFILE_URL", "http://ca.i10.tech/enroll/apple/profile")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected error for http profile URL")
		}
	})
}
