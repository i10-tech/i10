package main

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/appleattest"
	authdcfg "github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/enroll"
	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/mailfront"
)

const reloadEvery = 30 * time.Second

func main() {
	cfg, err := loadConfig()
	if err != nil {
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("invalid enrollctl configuration", slog.Any("err", err))
		os.Exit(2)
	}
	log := authdcfg.NewLogger(cfg.LogLevel)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	servingTLS := &mailfront.CertFiles{
		CertFile: cfg.TLSCertFile,
		KeyFile:  cfg.TLSKeyFile,
		Log:      log,
	}
	if err := servingTLS.Load(); err != nil {
		log.Error("failed to load enrollctl serving TLS certificate", slog.Any("err", err))
		os.Exit(1)
	}
	go servingTLS.Watch(ctx, reloadEvery)

	profileSigner := &enrollctl.ProfileSignerLoader{
		CertFile: cfg.ProfileCertFile,
		KeyFile:  cfg.ProfileKeyFile,
		Log:      log,
	}
	if err := profileSigner.Load(); err != nil {
		log.Error("failed to load profile signing certificate", slog.Any("err", err))
		os.Exit(1)
	}
	go profileSigner.Watch(ctx, reloadEvery)

	deviceIssuer := &enrollctl.DeviceCAIssuer{
		CertFile: cfg.DeviceCACertFile,
		KeyFile:  cfg.DeviceCAKeyFile,
		Log:      log,
	}
	if err := deviceIssuer.Load(); err != nil {
		log.Error("failed to load device CA intermediate", slog.Any("err", err))
		os.Exit(1)
	}
	go deviceIssuer.Watch(ctx, reloadEvery)

	deviceTrust := &enroll.DeviceCABundle{
		File: cfg.DeviceCABundle,
		Log:  log,
	}
	if err := deviceTrust.Load(); err != nil {
		log.Error("failed to load device CA trust bundle", slog.Any("err", err))
		os.Exit(1)
	}
	go deviceTrust.Watch(ctx, reloadEvery)

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

	pool, err := enrollctl.OpenEnrollWriterPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Error("failed to initialize enroll_writer pool", slog.Any("err", err))
		os.Exit(1)
	}
	defer pool.Close()

	batcher := enrollctl.NewBatcher(pool, enrollctl.BatcherConfig{
		MaxBatch: cfg.BatchMaxSize,
		MaxWait:  cfg.BatchMaxWait,
		Log:      log,
	})
	defer batcher.Close()

	handler := enrollctl.NewHandler(enrollctl.HandlerDeps{
		Store:            enrollredis.NewRedisStore(redisClient),
		Batcher:          batcher,
		EdgeLinkKeys:     cfg.EdgeLinkKeys,
		ACMEPermitKeys:   cfg.ACMEPermitKeys,
		ACMEPathKeys:     cfg.ACMEPathKeys,
		DeviceCodeKeys:   cfg.DeviceCodeKeys,
		ProfileSigner:    profileSigner,
		DeviceCAIssuer:   deviceIssuer,
		DeviceCATrust:    deviceTrust,
		AppleAttest:      appleattest.NewProductionVerifier(),
		EnrolldTokens:    cfg.EnrolldTokens,
		AcmedTokens:      cfg.AcmedTokens,
		ProfileURL:       cfg.ProfileURL,
		SCEPURL:          cfg.SCEPURL,
		ACMEDirectoryURL: cfg.ACMEDirectoryURL,
		IMAPHost:         cfg.IMAPHost,
		IMAPPort:         cfg.IMAPPort,
		SMTPHost:         cfg.SMTPHost,
		SMTPPort:         cfg.SMTPPort,
		Organization:     cfg.Organization,
		CallTimeout:      cfg.CallTimeout,
		Log:              log,
	})

	tlsCfg := mailfront.TLSConfig(servingTLS)
	tlsCfg.NextProtos = []string{"h2", "http/1.1"}
	ln, err := tls.Listen("tcp", cfg.Listen, tlsCfg)
	if err != nil {
		log.Error("enrollctl listen failed", "addr", cfg.Listen, slog.Any("err", err))
		os.Exit(1)
	}

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("enrollctl listening",
			"addr", ln.Addr().String(),
			"edge_kids", cfg.EdgeLinkKeys.IDs(),
			"acme_permit_kids", cfg.ACMEPermitKeys.IDs(),
			"acme_path_kids", cfg.ACMEPathKeys.IDs(),
			"device_code_kids", cfg.DeviceCodeKeys.IDs(),
			"batch_max_size", cfg.BatchMaxSize,
			"batch_max_wait", cfg.BatchMaxWait.String())
		errCh <- srv.Serve(ln)
	}()

	select {
	case <-ctx.Done():
		log.Info("enrollctl shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutCtx)
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("enrollctl serve failed", slog.Any("err", err))
			os.Exit(1)
		}
	}
}
