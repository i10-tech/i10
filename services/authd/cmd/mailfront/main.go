// Command mailfront is the TLS front for IMAP (993) and SMTP submission (465)
// in the Stalwart pod.
//
// It is a separate process from authd on purpose: it parses bytes from anyone
// on the internet before they have signed in, so a crash, a leak or a bug in it
// must not take LDAP down and must find no Clerk key, API secret or LDAP secret
// to leak. It holds a certificate, a read-only database connection and its
// settings, and nothing else. See "Mail front" in services/authd/README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/mailfront"
	"github.com/i10-tech/i10/services/authd/internal/projection"
)

// version is stamped at build time with -ldflags "-X main.version=<sha>".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("mailfront exited", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := mailfront.LoadConfig()
	if err != nil {
		return err
	}
	log := config.NewLogger(cfg.LogLevel)
	slog.SetDefault(log)
	log.Info("starting", "version", version)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// ⚠ A MISSING CERTIFICATE OR AN UNREACHABLE DATABASE AT START IS WAITED OUT,
	// NOT EXITED ON. The front is a container in the Stalwart pod: exiting would
	// put it in CrashLoopBackOff, with a delay that grows each time, for a blip
	// the next attempt would have survived. Until both are there the front
	// listens on nothing, so 993 and 465 refuse, and every attempt is logged.
	certs := &mailfront.CertFiles{CertFile: cfg.CertFile, KeyFile: cfg.KeyFile, Log: log}
	if err := retry(ctx, log, "load the certificate", certs.Load); err != nil {
		return err
	}
	go certs.Watch(ctx, 30*time.Second)

	var clientCAs *mailfront.ClientCAs
	if cfg.DeviceCABundle != "" {
		clientCAs = &mailfront.ClientCAs{File: cfg.DeviceCABundle, Log: log}
		if err := clientCAs.Load(); err != nil {
			// Optional bundle: keep running inert until the mounted file parses.
			log.Warn("device CA bundle could not be loaded at start, client certificates disabled until reload", slog.Any("err", err))
		}
		go clientCAs.Watch(ctx, 30*time.Second)
	}

	var store *projection.Postgres
	if err := retry(ctx, log, "connect to the projection", func() error {
		var err error
		store, err = projection.NewPostgres(ctx, cfg.DatabaseURL)
		return err
	}); err != nil {
		return err
	}
	defer store.Close()
	log.Info("projection connected")

	srv := mailfront.NewServer(store, mailfront.TLSConfig(certs), log)
	srv.IMAPTLS = mailfront.IMAPTLSConfig(certs, clientCAs)
	srv.ClientCAs = clientCAs
	srv.MacSMTPAnyAddress = !cfg.MacSMTPSameAddress
	srv.Limits.PreAuth = cfg.PreAuthTimeout
	srv.MaxConns, srv.MaxPreAuth, srv.MaxPreAuthPerIP = cfg.MaxConns, cfg.MaxPreAuth, cfg.MaxPreAuthPerIP
	srv.PassthroughMaxAge = cfg.PassthroughMaxAge
	srv.BindTokenKey = cfg.BindTokenKey
	if cfg.BindTokenKeyErr != nil {
		// ⚠ NOT FATAL: every sign-in is answered "temporarily unavailable" until
		// the key is there. authd would refuse a sign-in without the token anyway.
		log.Error("no bind token key: every sign-in will be answered as temporarily unavailable", slog.Any("err", cfg.BindTokenKeyErr))
	} else {
		log.Info("bind token key loaded", "id", int(cfg.BindTokenKey.ID))
	}

	// ⚠ THE TIMEOUT GUARDS A HUNG QUERY, NOT A LARGE ONE. A poll or sweep that
	// times out closes nothing, so a timeout below what the live set costs would
	// turn every revocation off. The duty cycle (nextWait) is what bounds the
	// load. MAILFRONT_SWEEP_INTERVAL is the change-driven poll's; the full sweep
	// runs once a minute beside it (DefaultBackstop).
	sweeper := srv.Sweeper(cfg.SweepInterval, 30*time.Second)
	go sweeper.Run(ctx)

	var (
		mu  sync.Mutex
		lns []net.Listener
		wg  sync.WaitGroup
	)
	errc := make(chan error, 2*len(cfg.ListenIPs))
	for _, ip := range cfg.ListenIPs {
		for _, l := range []struct {
			proto    mailfront.Protocol
			port     int
			upstream string
		}{
			{mailfront.IMAP, cfg.IMAPPort, cfg.IMAPUpstream},
			{mailfront.SMTP, cfg.SMTPPort, cfg.SMTPUpstream},
		} {
			addr := net.JoinHostPort(ip.String(), strconv.Itoa(l.port))
			wg.Add(1)
			go func() {
				defer wg.Done()
				ln, err := listenWhenFree(ctx, addr, log)
				if err != nil {
					if ctx.Err() == nil {
						errc <- err
					}
					return
				}
				mu.Lock()
				lns = append(lns, ln)
				mu.Unlock()
				log.Info("listening", "addr", addr, "proto", l.proto.String(), "upstream", l.upstream)
				if err := srv.Serve(ln, l.proto, l.upstream); err != nil {
					errc <- fmt.Errorf("serve %s: %w", addr, err)
				}
			}()
		}
	}

	var runErr error
	select {
	case <-ctx.Done():
		log.Info("shutting down: closing listeners and every connection; clients reconnect")
	case runErr = <-errc:
	}
	stop()
	mu.Lock()
	for _, ln := range lns {
		_ = ln.Close()
	}
	mu.Unlock()
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(sctx)
	wg.Wait()
	return runErr
}

// listenWhenFree binds addr, waiting while the port is taken.
//
// ⚠ THE PORT IS STALWART'S UNTIL ITS LISTENERS MOVE TO LOOPBACK. On the first
// rollout the pod starts before bootstrap.sh has moved `imaps` and
// `submissions` to 127.0.0.1, and Stalwart applies a listener change only on a
// restart. Until then Stalwart holds [::]:993 and [::]:465, serves them itself
// exactly as before, and this waits, as long as it takes. Any other failure (an
// address the pod does not have) is a configuration error: it is retried for
// half a minute and then ends the process with that error.
func listenWhenFree(ctx context.Context, addr string, log *slog.Logger) (net.Listener, error) {
	var lastLog, otherSince time.Time
	for {
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, nil
		}
		if errors.Is(err, syscall.EADDRINUSE) {
			otherSince = time.Time{}
			if time.Since(lastLog) > 30*time.Second {
				log.Warn("port is taken, waiting: Stalwart still listens here until its listeners move to loopback",
					"addr", addr)
				lastLog = time.Now()
			}
		} else {
			if otherSince.IsZero() {
				otherSince = time.Now()
				log.Error("cannot listen, retrying for 30s", "addr", addr, slog.Any("err", err))
			} else if time.Since(otherSince) > 30*time.Second {
				return nil, fmt.Errorf("listen on %s: %w", addr, err)
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// retry runs fn until it succeeds or ctx ends, backing off from one second to
// thirty with jitter, and logs every failure.
func retry(ctx context.Context, log *slog.Logger, what string, fn func() error) error {
	wait := time.Second
	for attempt := 1; ; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		log.Warn("cannot "+what+", retrying", "attempt", attempt, "in", wait.String(), slog.Any("err", err))
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s: %w", what, err)
		case <-time.After(wait/2 + rand.N(wait/2+1)):
		}
		wait = min(2*wait, 30*time.Second)
	}
}
