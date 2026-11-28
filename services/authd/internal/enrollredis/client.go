// Package enrollredis is the enrollment state on i10-enroll-redis: sessions,
// SCEP permits, the sealed retry cache, the notice stream and acmed's ACME
// state, each change one Lua script (lua/) or one command.
//
// Design properties (db-guard references/redis.md):
//   - Every key written carries a positive TTL.
//   - Every multi-key transition runs as one Lua script (EVALSHA, SCRIPT LOAD on
//     NOSCRIPT), with every key it touches in KEYS so each client's ACL applies.
//   - Every call is bounded by its context deadline; Redis down or OOM
//     (noeviction) returns an error so callers fail closed (503).
package enrollredis

import (
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/redis/go-redis/v9/maintnotifications"
)

const (
	defaultPoolSize     = 8
	maxPoolSize         = 64
	defaultDialTimeout  = 2 * time.Second
	defaultReadTimeout  = 3 * time.Second
	defaultWriteTimeout = 2 * time.Second
)

// Config configures a Redis client.
type Config struct {
	// URL is redis:// or rediss:// host:port[/db]. Userinfo in the URL is used
	// when Username/Password are empty; explicit Username/Password override it.
	URL          string
	Username     string
	Password     string
	PoolSize     int
	DialTimeout  time.Duration
	ReadTimeout  time.Duration
	WriteTimeout time.Duration
}

// NewClient opens a pooled go-redis client for one ACL user.
//
// ⚠ THE CONNECTION HANDSHAKE SENDS ONLY HELLO/AUTH. CLIENT SETINFO and
// CLIENT MAINT_NOTIFICATIONS are switched off: every ACL user starts from
// -@all and is allowed only the commands its code sends (enroll-redis.yaml,
// acl_redis_test.go).
func NewClient(cfg Config) (*redis.Client, error) {
	opt, err := redis.ParseURL(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("enrollredis: parse ENROLL_REDIS_URL: %w", err)
	}
	if cfg.Username != "" {
		opt.Username = cfg.Username
	}
	if cfg.Password != "" {
		opt.Password = cfg.Password
	}
	opt.PoolSize = cfg.PoolSize
	if opt.PoolSize <= 0 {
		opt.PoolSize = defaultPoolSize
	}
	if opt.PoolSize > maxPoolSize {
		opt.PoolSize = maxPoolSize
	}
	opt.DialTimeout = orDefault(cfg.DialTimeout, defaultDialTimeout)
	opt.ReadTimeout = orDefault(cfg.ReadTimeout, defaultReadTimeout)
	opt.WriteTimeout = orDefault(cfg.WriteTimeout, defaultWriteTimeout)
	// Per-call deadlines: a context deadline bounds the socket wait too.
	opt.ContextTimeoutEnabled = true
	opt.Protocol = 2
	opt.DisableIdentity = true
	opt.MaintNotificationsConfig = &maintnotifications.Config{Mode: maintnotifications.ModeDisabled}
	// One attempt: a retry would double a non-idempotent script under a deadline
	// the caller already set.
	opt.MaxRetries = -1
	return redis.NewClient(opt), nil
}

func orDefault(d, def time.Duration) time.Duration {
	if d <= 0 {
		return def
	}
	return d
}
