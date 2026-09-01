// Command authd is i10's LDAP bridge between Stalwart and Clerk.
//
// It runs as a sidecar in the Stalwart pod, listening on loopback only.
// Stalwart is configured with an LDAP directory using bindAuthentication=true,
// so it locates a user's DN with a search and then binds as that user; authd
// answers the search from a local projection of Clerk and answers the bind by
// asking Clerk. i10 stores no password material anywhere.
//
// The product rule this exists to serve: a user has one identity they know of
// — one email, one password — and it opens both the dashboard and the mailbox.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	ldap "github.com/vjeantet/ldapserver"

	"github.com/i10-tech/i10/services/authd/internal/clerkauth"
	"github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/ldapsrv"
	"github.com/i10-tech/i10/services/authd/internal/projection"
	"github.com/i10-tech/i10/services/authd/internal/throttle"
)

// version is stamped at build time with -ldflags "-X main.version=<sha>".
// Without this declaration that flag is silently ignored.
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("authd exited", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := newLogger(cfg.LogLevel)
	slog.SetDefault(log)

	// The library logs through a package-level standard logger. Route it into
	// slog so pod output is one stream in one format.
	ldap.Logger = slog.NewLogLogger(log.Handler(), slog.LevelDebug)

	log.Info("starting", "version", version)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := projection.NewPostgres(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer store.Close()
	log.Info("projection connected")

	limiter := throttle.New(cfg.BindsPerMinute)
	go sweepLoop(ctx, limiter, log)

	srv := ldap.NewServer()
	srv.ReadTimeout = 30 * time.Second
	srv.WriteTimeout = 30 * time.Second
	srv.Handle(ldapsrv.New(ldapsrv.Options{
		BaseDN:            cfg.BaseDN,
		ServiceBindDN:     cfg.ServiceBindDN,
		ServiceBindSecret: cfg.ServiceBindSecret,
		Store:             store,
		Verifier:          clerkauth.New(cfg.ClerkBaseURL, cfg.ClerkSecretKey, cfg.ClerkTimeout),
		Limiter:           limiter,
		Logger:            log,
	}).Routes())

	// The listener is created here, on this goroutine, rather than inside
	// ListenAndServe.
	//
	// ⚠ UPSTREAM RACE. ldapserver assigns s.Listener inside Serve while Stop
	// reads it, with no synchronisation (server.go:82 vs :186). A SIGTERM
	// arriving in the microseconds before that assignment would have Stop
	// dereference a nil Listener and turn a graceful shutdown into a panic.
	// Binding first and then waiting until the server is provably accepting
	// closes that window, and it also gives us a real readiness signal:
	// Stalwart must not start issuing binds before authd can answer them.
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Listen, err)
	}

	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()

	if err := waitAccepting(ctx, ln.Addr().String()); err != nil {
		srv.Stop()
		return err
	}
	log.Info("listening", "addr", ln.Addr().String(), "baseDN", cfg.BaseDN)

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		// Stop() waits for in-flight operations, so a bind mid-flight to Clerk
		// completes rather than returning a spurious failure to a mail client.
		srv.Stop()
		return nil
	}
}

// waitAccepting blocks until the server answers a TCP connection, so callers
// know Serve has entered its accept loop.
func waitAccepting(ctx context.Context, addr string) error {
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, err := net.DialTimeout("tcp", addr, 250*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("server did not start accepting on %s: %w", addr, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}

// sweepLoop keeps the limiter's map from growing once per distinct DN ever
// probed. A bucket idle for longer than its own refill window has nothing left
// to remember.
func sweepLoop(ctx context.Context, l *throttle.Limiter, log *slog.Logger) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if n := l.Sweep(10 * time.Minute); n > 0 {
				log.Debug("throttle swept", "removed", n, "remaining", l.Len())
			}
		}
	}
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	if err := lvl.UnmarshalText([]byte(level)); err != nil {
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}
