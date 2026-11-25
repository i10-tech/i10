// Command cahookrelay is the loopback TLS webhook relay sidecar in the step-ca
// pod (#383 PR 3).
//
// step-ca exposes its webhook URLs in its unauthenticated GET /provisioners
// response and logs them on transport errors, and drops Webhook.Secret and
// BearerToken written in ca.json when no admin database is enabled. So step-ca
// calls this relay on https://127.0.0.1:<port>/<hook> (with no secret in the
// URL), and this relay forwards only the four known webhook paths to the API's
// :3443 hooks listener with Authorization: Bearer <token> read from its own
// mounted Secret file.
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

	token := &tokenFile{File: cfg.TokenFile, Log: log}
	if err := token.Load(); err != nil {
		return err
	}
	go token.Watch(ctx, 30*time.Second)

	client, err := newUpstreamClient(cfg.UpstreamCAFile, cfg.UpstreamTimeout)
	if err != nil {
		return err
	}

	relay := &hookRelay{
		upstreamBase: cfg.UpstreamURL,
		token:        token.Get,
		client:       client,
		log:          log,
	}

	srv := &http.Server{
		Handler:           relay,
		TLSConfig:         mailfront.TLSConfig(certs),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.UpstreamTimeout + 5*time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("cahookrelay: listen on %s: %w", cfg.Listen, err)
	}
	tlsLn := tls.NewListener(ln, srv.TLSConfig)
	log.Info("listening", "addr", ln.Addr().String(), "upstream", cfg.UpstreamURL)

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
