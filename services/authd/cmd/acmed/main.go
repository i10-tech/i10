package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/acmed"
	"github.com/i10-tech/i10/services/authd/internal/appleattest"
	authdcfg "github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
)

func main() {
	cfg, err := loadConfig()
	if err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("invalid acmed configuration", slog.Any("err", err))
		os.Exit(2)
	}
	log := authdcfg.NewLogger(cfg.LogLevel)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	redisClient, err := enrollredis.NewClient(enrollredis.Config{
		URL:      cfg.RedisURL,
		Username: cfg.RedisUser,
		Password: cfg.RedisPassword,
		PoolSize: 16,
	})
	if err != nil {
		log.Error("failed to initialize enroll redis client", slog.Any("err", err))
		os.Exit(1)
	}
	defer redisClient.Close()

	finalizer, err := acmed.NewEnrollctlClientFromCAFile(
		cfg.EnrollctlURL,
		cfg.EnrollctlToken,
		cfg.EnrollctlCAFile,
		cfg.UpstreamTimeout,
	)
	if err != nil {
		log.Error("failed to initialize enrollctl client", slog.Any("err", err))
		os.Exit(1)
	}

	handler := acmed.NewHandler(acmed.HandlerDeps{
		Store:              enrollredis.NewRedisStore(redisClient),
		Finalizer:          finalizer,
		NonceKeys:          cfg.NonceKeys,
		PathKeys:           cfg.PathKeys,
		AppleAttest:        appleattest.NewProductionVerifier(),
		BaseURL:            cfg.BaseURL,
		Prefix:             cfg.Prefix,
		MaxOrdersPerDevice: cfg.MaxOrdersPerDevice,
		RequestTimeout:     cfg.requestTimeout(),
		Log:                log,
	})

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		log.Error("acmed listen failed", "addr", cfg.Listen, slog.Any("err", err))
		os.Exit(1)
	}
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      cfg.writeTimeout(),
		IdleTimeout:       60 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("acmed listening", "addr", ln.Addr().String(), "base_url", cfg.BaseURL, "prefix", cfg.Prefix)
		errCh <- srv.Serve(ln)
	}()

	select {
	case <-ctx.Done():
		log.Info("acmed shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("acmed serve failed", slog.Any("err", err))
			os.Exit(1)
		}
	}
}
