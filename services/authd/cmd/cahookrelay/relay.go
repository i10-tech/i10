package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/mailfront"
)

const (
	// maxBodyBytes caps incoming step-ca webhook bodies (and upstream responses)
	// at 64 KiB, matching the API's :3443 hooks listener (revision 5).
	maxBodyBytes = 64 << 10

	headerSmallstepSig = "X-Smallstep-Signature"
	headerSmallstepID  = "X-Smallstep-Webhook-ID"
)

// allowedPaths is the exact set of webhook paths the relay forwards to the API.
// Anything else receives 404 without reaching the upstream.
var allowedPaths = map[string]bool{
	"/acme-authorize": true,
	"/scep-challenge": true,
	"/scep-authorize": true,
	"/scep-notify":    true,
}

type relayConfig struct {
	Listen          string
	CertFile        string
	KeyFile         string
	UpstreamURL     string
	UpstreamCAFile  string
	TokenFile       string
	UpstreamTimeout time.Duration
	LogLevel        string
}

func loadConfig() (relayConfig, error) {
	c := relayConfig{
		Listen:         config.Env("CAHOOKRELAY_LISTEN", "127.0.0.1:9443"),
		CertFile:       config.Env("CAHOOKRELAY_TLS_CERT_FILE", "/etc/cahookrelay/tls/tls.crt"),
		KeyFile:        config.Env("CAHOOKRELAY_TLS_KEY_FILE", "/etc/cahookrelay/tls/tls.key"),
		UpstreamURL:    strings.TrimRight(config.Env("CAHOOKRELAY_UPSTREAM_URL", ""), "/"),
		UpstreamCAFile: config.Env("CAHOOKRELAY_UPSTREAM_CA_FILE", ""),
		TokenFile:      config.Env("CAHOOKRELAY_TOKEN_FILE", ""),
		LogLevel:       config.Env("CAHOOKRELAY_LOG_LEVEL", "info"),
	}
	var err error
	if c.UpstreamTimeout, err = config.EnvDuration("CAHOOKRELAY_UPSTREAM_TIMEOUT", 10*time.Second); err != nil {
		return c, err
	}
	return c, c.validate()
}

func (c relayConfig) validate() error {
	var errs []error
	host, port, err := net.SplitHostPort(c.Listen)
	if err != nil || port == "" {
		errs = append(errs, fmt.Errorf("CAHOOKRELAY_LISTEN must be host:port, got %q", c.Listen))
	} else {
		ip, perr := netip.ParseAddr(host)
		if perr != nil || !ip.IsLoopback() {
			errs = append(errs, fmt.Errorf("CAHOOKRELAY_LISTEN must be a loopback IP (127.0.0.1 or ::1), got %q", c.Listen))
		}
	}
	if c.CertFile == "" || c.KeyFile == "" {
		errs = append(errs, errors.New("CAHOOKRELAY_TLS_CERT_FILE and CAHOOKRELAY_TLS_KEY_FILE are required"))
	}
	if c.UpstreamURL == "" {
		errs = append(errs, errors.New("CAHOOKRELAY_UPSTREAM_URL is required"))
	} else if u, err := url.Parse(c.UpstreamURL); err != nil || u.Scheme != "https" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		errs = append(errs, fmt.Errorf("CAHOOKRELAY_UPSTREAM_URL must be an https URL without query or fragment, got %q", c.UpstreamURL))
	}
	if c.UpstreamCAFile == "" {
		errs = append(errs, errors.New("CAHOOKRELAY_UPSTREAM_CA_FILE is required"))
	}
	if c.TokenFile == "" {
		errs = append(errs, errors.New("CAHOOKRELAY_TOKEN_FILE is required"))
	}
	if c.UpstreamTimeout < time.Second || c.UpstreamTimeout > 30*time.Second {
		errs = append(errs, fmt.Errorf("CAHOOKRELAY_UPSTREAM_TIMEOUT is %s: keep it between 1s and 30s", c.UpstreamTimeout))
	}
	return errors.Join(errs...)
}

// tokenFile holds the bearer token read from a mounted Secret file and reloaded
// periodically so token rotation needs no restart.
type tokenFile struct {
	File string
	Log  *slog.Logger

	cur atomic.Pointer[string]
}

func (t *tokenFile) Load() error {
	raw, err := os.ReadFile(t.File)
	if err != nil {
		return fmt.Errorf("cahookrelay: read token file: %w", err)
	}
	tok := strings.TrimSpace(string(raw))
	if tok == "" || strings.ContainsAny(tok, "\r\n") {
		return errors.New("cahookrelay: token file is empty or contains a line break")
	}
	t.cur.Store(&tok)
	return nil
}

func (t *tokenFile) Get() string {
	p := t.cur.Load()
	if p == nil {
		return ""
	}
	return *p
}

func (t *tokenFile) Watch(ctx context.Context, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			if err := t.Load(); err != nil && t.Log != nil {
				// Never log token contents.
				t.Log.Warn("token file reload failed, keeping the current token", slog.Any("err", err))
			}
		}
	}
}

func newUpstreamClient(caFile string, timeout time.Duration) (*http.Client, error) {
	raw, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("cahookrelay: read upstream CA file: %w", err)
	}
	pool, _, err := mailfront.ParseCertPool(raw)
	if err != nil {
		return nil, fmt.Errorf("cahookrelay: upstream CA file: %w", err)
	}

	transport := &http.Transport{
		Proxy: nil, // Never follow environment proxies with the bearer token.
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig: &tls.Config{
			RootCAs:    pool,
			MinVersion: tls.VersionTLS12,
		},
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: timeout,
		MaxIdleConns:          16,
		IdleConnTimeout:       60 * time.Second,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			// Never follow redirects with the bearer token.
			return http.ErrUseLastResponse
		},
	}, nil
}

// hookRelay forwards POST requests for allowedPaths to upstreamBase with the
// configured bearer token and the two Smallstep webhook headers.
//
// ⚠ NEVER LOGS THE TOKEN, BODIES OR HEADERS.
type hookRelay struct {
	upstreamBase string
	token        func() string
	client       *http.Client
	log          *slog.Logger
}

func (h *hookRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !allowedPaths[r.URL.Path] || r.URL.RawQuery != "" {
		http.NotFound(w, r)
		return
	}
	path := r.URL.Path
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}

	tok := h.token()
	if tok == "" {
		h.log.Error("webhook relay has no token configured", "path", path)
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}

	start := time.Now()
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, h.upstreamBase+path, bytes.NewReader(body))
	if err != nil {
		h.log.Error("webhook relay could not build upstream request", "path", path)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	ct := r.Header.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	req.Header.Set("Content-Type", ct)
	if sig := r.Header.Get(headerSmallstepSig); sig != "" {
		req.Header.Set(headerSmallstepSig, sig)
	}
	if wid := r.Header.Get(headerSmallstepID); wid != "" {
		req.Header.Set(headerSmallstepID, wid)
	}

	resp, err := h.client.Do(req)
	if err != nil {
		h.log.Warn("webhook upstream call failed", "path", path,
			"duration", time.Since(start).Round(time.Millisecond).String(), slog.Any("err", err))
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil || len(respBody) > maxBodyBytes {
		h.log.Warn("webhook upstream response unreadable or too large", "path", path, "status", resp.StatusCode)
		http.Error(w, "bad gateway", http.StatusBadGateway)
		return
	}

	if respCT := resp.Header.Get("Content-Type"); respCT != "" {
		w.Header().Set("Content-Type", respCT)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(respBody)
	h.log.Info("webhook relayed", "path", path, "status", resp.StatusCode,
		"duration", time.Since(start).Round(time.Millisecond).String())
}
