// Command cahookrelay is the loopback TLS SCEP webhook handler sidecar in the
// step-ca pod.
//
// step-ca calls this sidecar on https://127.0.0.1:9443/scep-challenge and
// https://127.0.0.1:9443/scep-authorize. cahookrelay validates the Smallstep
// webhook ID, body timestamp, and strict x509util SCEP template rules locally,
// and coordinates SCEP permits atomically against i10-enroll-redis under the
// `cahookrelay` Redis ACL: read and write enroll:scep:*, read-only
// enroll:sess:*, and only the commands its scripts run (see scepHookHandler).
// ACME issuance moved to acmed + enrollctl, and scep-notify was removed.
//
// ⚠ A COMPROMISED cahookrelay CAN HIJACK AN ENROLLMENT IN SCEP. step-ca sends
// it every in-flight challenge in plaintext, so it can bind a victim's
// enrollment to its own key, and enrollctl cannot tell that binding apart; the
// same holds for step-ca itself. That is inherent to SCEP. What the ACL and
// the plaintext-in-binding rule bound: a party who can only write Redis cannot
// bind anything, and the relay cannot write a session, touch one that is not
// in SCEP, or reach a sealed profile or a minted device.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/mailfront"
)

// version is stamped at build time with -ldflags "-X main.version=<sha>".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("cahookrelay exited", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	log := config.NewLogger(cfg.LogLevel)
	slog.SetDefault(log)
	log.Info("starting", "version", version)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	certs := &mailfront.CertFiles{CertFile: cfg.CertFile, KeyFile: cfg.KeyFile, Log: log}
	if err := certs.Load(); err != nil {
		return err
	}
	go certs.Watch(ctx, 30*time.Second)

	rc, err := enrollredis.NewClient(enrollredis.Config{
		URL:          cfg.RedisURL,
		Username:     cfg.RedisUser,
		Password:     cfg.RedisPassword,
		ReadTimeout:  cfg.RedisTimeout,
		WriteTimeout: cfg.RedisTimeout,
		PoolSize:     8,
	})
	if err != nil {
		return fmt.Errorf("cahookrelay: redis client: %w", err)
	}
	defer rc.Close()

	handler := &scepHookHandler{
		store:                enrollredis.NewRedisStore(rc),
		webhookIDs:           cfg.WebhookIDs,
		intermediateNotAfter: cfg.IntermediateNotAfter,
		timeout:              cfg.RedisTimeout,
		log:                  log,
	}

	srv := &http.Server{
		Handler:           handler,
		TLSConfig:         mailfront.TLSConfig(certs),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.RedisTimeout + 5*time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("cahookrelay: listen on %s: %w", cfg.Listen, err)
	}
	tlsLn := tls.NewListener(ln, srv.TLSConfig)
	log.Info("listening", "addr", ln.Addr().String())

	errc := make(chan error, 1)
	go func() {
		if err := srv.Serve(tlsLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
		close(errc)
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(sctx)
	}
}
