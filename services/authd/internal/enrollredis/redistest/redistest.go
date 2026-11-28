// Package redistest opens a real i10-enroll-redis for tests: a Redis named by
// ENROLL_TEST_REDIS_URL, or a skip. Only test files import it, so no
// production binary can reach it.
//
// ⚠ THERE IS NO IN-MEMORY STAND-IN. The Lua scripts are the enrollment state
// machine; a Go copy of them would test a different state machine from the one
// that runs. Every key a test writes is unique to the test, so runs can share
// one server.
//
//	ENROLL_TEST_REDIS_URL=redis://127.0.0.1:6379 go test ./...
package redistest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/redis/go-redis/v9"
)

// URL returns ENROLL_TEST_REDIS_URL or skips the test. With
// ENROLL_TEST_REDIS_REQUIRED set (CI), a missing URL fails instead.
func URL(t testing.TB) string {
	t.Helper()
	u := os.Getenv("ENROLL_TEST_REDIS_URL")
	if u == "" {
		if os.Getenv("ENROLL_TEST_REDIS_REQUIRED") != "" {
			t.Fatal("ENROLL_TEST_REDIS_URL is required (ENROLL_TEST_REDIS_REQUIRED is set)")
		}
		t.Skip("ENROLL_TEST_REDIS_URL is not set")
	}
	return u
}

// Open returns a store and its client on the test Redis (the unrestricted
// default user), closed at the end of the test.
func Open(t testing.TB) (*enrollredis.RedisStore, *redis.Client) {
	t.Helper()
	c, err := enrollredis.NewClient(enrollredis.Config{URL: URL(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping test Redis: %v", err)
	}
	return enrollredis.NewRedisStore(c), c
}

// ID is a random hex string for test-unique keys.
func ID(t testing.TB) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b[:])
}

// Notices returns the enroll:notice entries for deviceID.
func Notices(t testing.TB, c *redis.Client, deviceID string) []map[string]any {
	t.Helper()
	msgs, err := c.XRange(context.Background(), enrollredis.NoticeStreamKey, "-", "+").Result()
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, m := range msgs {
		if m.Values["deviceId"] == deviceID {
			out = append(out, m.Values)
		}
	}
	return out
}

// PutSCEPKeyBinding writes a key binding as cahookrelay's scripts would.
func PutSCEPKeyBinding(t testing.TB, c *redis.Client, kb enrollredis.SCEPKeyBinding, ttl time.Duration) {
	t.Helper()
	raw, err := json.Marshal(kb)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Set(context.Background(), enrollredis.SCEPKeyKey(kb.KeySha256), raw, ttl).Err(); err != nil {
		t.Fatal(err)
	}
}
