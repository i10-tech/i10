// Command enrolld is the Apple over-the-air enrollment HTTP service.
//
// It sits behind Traefik (which terminates TLS for ca.i10.tech and routes only
// /enroll/apple/) and talks to enrollctl's internal :3443 listener over HTTPS
// pinned to the namespace hooks CA. It holds ONLY ENROLL_EDGE_HMAC_KEY (to
// reject forged or expired link tokens locally with zero upstream traffic) and
// its enrollctl bearer token. It holds no database credentials, no Redis
// credentials, no device-code keys, no profile signing key, and no profile
// rendering or CMS encryption code: every signed profile comes from enrollctl.
package main

import (
	"context"
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
	"github.com/i10-tech/i10/services/authd/internal/enroll"
)

// version is stamped at build time with -ldflags "-X main.version=<sha>".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("enrolld exited", "err", err)
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

	deviceBundle := &enroll.DeviceCABundle{
		File: cfg.DeviceCABundle,
		Log:  log,
	}
	if err := deviceBundle.Load(); err != nil {
		return err
	}
	go deviceBundle.Watch(ctx, 30*time.Second)

	apiClient, err := enroll.NewAPIClient(cfg.APIURL, cfg.APICAFile, cfg.APIToken, cfg.APITimeout)
	if err != nil {
		return err
	}

	handler, err := enroll.NewHandler(enroll.HandlerConfig{
		API:           apiClient,
		Trust:         deviceBundle.Current,
		EdgeLinkKeys:  cfg.EdgeLinkKeys,
		MaxConcurrent: cfg.MaxConcurrent,
		Log:           log,
	})
	if err != nil {
		return err
	}

	writeTimeout := max(15*time.Second, cfg.APITimeout+5*time.Second)
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    8 << 10,
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("enrolld: listen on %s: %w", cfg.Listen, err)
	}
	log.Info("listening", "addr", ln.Addr().String(), "enrollctl", cfg.APIURL)

	errc := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
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
