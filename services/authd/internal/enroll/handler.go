package enroll

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

const (
	// enrollTokenLen is the exact unpadded base64url length of a 32-byte token.
	enrollTokenLen = 43

	defaultMaxConcurrent = 16
	serialHMACBytes      = 8 // 16 hex chars, keyed per process
)

// APICaller is the narrow interface Handler uses to reach the internal API.
// *APIClient implements it.
type APICaller interface {
	Peek(ctx context.Context, token string) (bool, error)
	Attest(ctx context.Context, req AttestRequest) (*AttestResponse, error)
	Finish(ctx context.Context, req FinishRequest) (*FinishResponse, error)
}

// HandlerConfig configures Handler.
type HandlerConfig struct {
	API           APICaller
	Trust         func() *DeviceTrust
	ProfileURL    string
	SCEPURL       string
	MaxConcurrent int
	Log           *slog.Logger
	Now           func() time.Time
}

// Handler serves the Apple over-the-air enrollment HTTP surface:
//   - GET  /healthz               (bare 200, leaks nothing)
//   - GET  /enroll/apple/<token>  (phase 1 Profile Service profile)
//   - POST /enroll/apple/profile  (phase 2 SCEP profile, phase 4 sealed profile)
//   - everything else: 404
//
// ⚠ LOG REDACTION: never logs a token, a challenge, attributes beyond product,
// the inner plist or a device code. Serials appear only as a truncated
// HMAC-SHA256 under a random per-process key.
type Handler struct {
	api        APICaller
	trust      func() *DeviceTrust
	profileURL string
	scepURL    string
	sem        chan struct{}
	serialKey  [32]byte
	log        *slog.Logger
	now        func() time.Time
}

// NewHandler constructs a hardened OTA enrollment HTTP handler.
func NewHandler(cfg HandlerConfig) (*Handler, error) {
	if cfg.API == nil {
		return nil, errors.New("enroll: API client is required")
	}
	if cfg.Trust == nil {
		return nil, errors.New("enroll: device CA trust provider is required")
	}
	if cfg.ProfileURL == "" || cfg.SCEPURL == "" {
		return nil, errors.New("enroll: ProfileURL and SCEPURL are required")
	}
	maxConc := cfg.MaxConcurrent
	if maxConc <= 0 {
		maxConc = defaultMaxConcurrent
	}
	log := cfg.Log
	if log == nil {
		log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}

	h := &Handler{
		api:        cfg.API,
		trust:      cfg.Trust,
		profileURL: cfg.ProfileURL,
		scepURL:    cfg.SCEPURL,
		sem:        make(chan struct{}, maxConc),
		log:        log,
		now:        now,
	}
	if _, err := rand.Read(h.serialKey[:]); err != nil {
		return nil, errors.New("enroll: failed to initialize serial HMAC key")
	}
	return h, nil
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			h.log.Error("enrollment handler panic recovered")
			writeBareError(w, http.StatusInternalServerError)
		}
	}()

	// Health probe: exact path, GET only, no query string, bypasses the
	// enrollment concurrency semaphore, leaks nothing.
	if r.URL.Path == "/healthz" {
		if r.Method == http.MethodGet && r.URL.RawQuery == "" && r.URL.RawPath == "" {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusOK)
			return
		}
		writeBareError(w, http.StatusNotFound)
		return
	}

	// Query strings and percent-encoded paths are never part of the two routes.
	if r.URL.RawQuery != "" || r.URL.RawPath != "" {
		writeBareError(w, http.StatusNotFound)
		return
	}

	if r.URL.Path == "/enroll/apple/profile" {
		if r.Method != http.MethodPost {
			writeBareError(w, http.StatusNotFound)
			return
		}
		// ⚠ THE BODY IS READ BEFORE THE REQUEST TAKES A CONCURRENCY SLOT. A
		// client that sends its body slowly then holds only its own connection
		// (until the server's ReadTimeout), never a slot a real device needs.
		start := h.now()
		body, ok := h.readProfileBody(w, r)
		if !ok {
			return
		}
		h.withConcurrency(w, r, func(w http.ResponseWriter, r *http.Request) {
			h.handleProfilePost(w, r, body, start)
		})
		return
	}

	if token, ok := strings.CutPrefix(r.URL.Path, "/enroll/apple/"); ok {
		if r.Method != http.MethodGet || !isValidToken(token) {
			writeBareError(w, http.StatusNotFound)
			return
		}
		h.withConcurrency(w, r, func(w http.ResponseWriter, r *http.Request) {
			h.handlePhase1Get(w, r, token)
		})
		return
	}

	writeBareError(w, http.StatusNotFound)
}

func (h *Handler) withConcurrency(w http.ResponseWriter, r *http.Request, next func(http.ResponseWriter, *http.Request)) {
	select {
	case h.sem <- struct{}{}:
		defer func() { <-h.sem }()
		next(w, r)
	default:
		h.log.Warn("enrollment concurrency limit reached")
		writeBareError(w, http.StatusServiceUnavailable)
	}
}

func (h *Handler) handlePhase1Get(w http.ResponseWriter, r *http.Request, token string) {
	start := h.now()
	live, err := h.api.Peek(r.Context(), token)
	dur := h.now().Sub(start).Round(time.Millisecond).String()
	if err != nil {
		h.log.Warn("enrollment request failed", "phase", 1, "outcome", "api_error", "duration", dur)
		writeBareError(w, http.StatusServiceUnavailable)
		return
	}
	if !live {
		h.log.Info("enrollment request handled", "phase", 1, "outcome", "not_live", "duration", dur)
		writeBareError(w, http.StatusNotFound)
		return
	}
	profile, err := RenderPhase1Profile(h.profileURL, token)
	if err != nil {
		h.log.Error("phase 1 profile render failed", "phase", 1, "outcome", "render_error")
		writeBareError(w, http.StatusServiceUnavailable)
		return
	}
	writeMobileConfig(w, profile)
	h.log.Info("enrollment request handled", "phase", 1, "outcome", "ok", "duration", dur)
}

// readProfileBody reads the capped POST body, answering the refusal itself
// when it is too large or cannot be read.
func (h *Handler) readProfileBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err == nil {
		return body, true
	}
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		h.log.Warn("enrollment request rejected", "outcome", "body_too_large")
		writeBareError(w, http.StatusRequestEntityTooLarge)
		return nil, false
	}
	h.log.Warn("enrollment request rejected", "outcome", "body_read_error")
	writeBareError(w, http.StatusBadRequest)
	return nil, false
}

func (h *Handler) handleProfilePost(w http.ResponseWriter, r *http.Request, body []byte, start time.Time) {
	cms, err := ParseAndVerifyCMS(body)
	if err != nil {
		h.log.Info("enrollment request rejected", "outcome", "cms_invalid")
		writeBareError(w, http.StatusBadRequest)
		return
	}

	phase, err := ClassifySigner(cms, h.trust(), h.now())
	if err != nil {
		h.log.Info("enrollment request rejected", "outcome", "signer_rejected")
		writeBareError(w, http.StatusBadRequest)
		return
	}

	attrs, err := ParseAttributesPlist(cms.Content)
	if err != nil {
		h.log.Info("enrollment request rejected", "phase", phaseNumber(phase), "outcome", "plist_invalid")
		writeBareError(w, http.StatusBadRequest)
		return
	}

	switch phase {
	case Phase2Apple:
		h.handlePhase2(w, r, cms, attrs, start)
	case Phase4DeviceCA:
		h.handlePhase4(w, r, cms, attrs, start)
	default:
		writeBareError(w, http.StatusBadRequest)
	}
}

func (h *Handler) handlePhase2(w http.ResponseWriter, r *http.Request, cms *VerifiedCMS, attrs map[string]string, start time.Time) {
	token := attrs["CHALLENGE"]
	udid := attrs["UDID"]
	serial := attrs["SERIAL"]
	product := attrs["PRODUCT"]
	osVersion := attrs["VERSION"]

	if !isValidToken(token) || udid == "" || serial == "" || product == "" || osVersion == "" {
		h.log.Info("enrollment request rejected", "phase", 2, "outcome", "missing_attributes",
			"product", clampLog(product, 64))
		writeBareError(w, http.StatusBadRequest)
		return
	}

	signerSum := sha256.Sum256(cms.Signer.Raw)
	serialHash := h.hashSerial(serial)
	safeProduct := clampLog(product, 64)

	resp, err := h.api.Attest(r.Context(), AttestRequest{
		Token:             token,
		UDID:              udid,
		Serial:            serial,
		Product:           product,
		Version:           osVersion,
		DeviceName:        optionalAttr(attrs["DEVICE_NAME"]),
		Model:             optionalAttr(attrs["MODEL"]),
		AppleSignerSHA256: hex.EncodeToString(signerSum[:]),
	})
	dur := h.now().Sub(start).Round(time.Millisecond).String()
	if err != nil {
		h.log.Warn("enrollment request failed", "phase", 2, "outcome", "api_error",
			"product", safeProduct, "serial_hmac", serialHash, "duration", dur)
		writeBareError(w, http.StatusServiceUnavailable)
		return
	}
	if resp.Outcome == "refused" {
		h.log.Info("enrollment request refused", "phase", 2, "outcome", "refused",
			"reason", clampLog(resp.Reason, 64), "product", safeProduct,
			"serial_hmac", serialHash, "duration", dur)
		writeBareError(w, http.StatusBadRequest)
		return
	}

	profile, err := RenderSCEPProfile(h.scepURL, resp.Serial, resp.Challenge)
	if err != nil {
		h.log.Error("phase 2 SCEP profile render failed", "phase", 2, "outcome", "render_error",
			"product", safeProduct, "serial_hmac", serialHash)
		writeBareError(w, http.StatusServiceUnavailable)
		return
	}
	writeMobileConfig(w, profile)
	h.log.Info("enrollment request handled", "phase", 2, "outcome", "scep",
		"product", safeProduct, "serial_hmac", h.hashSerial(resp.Serial), "duration", dur)
}

func (h *Handler) handlePhase4(w http.ResponseWriter, r *http.Request, cms *VerifiedCMS, attrs map[string]string, start time.Time) {
	// ⚠ NO ENCRYPTION IN ENROLLD (Review 1 rule M1). Forward the verified phase
	// 4 signer DER to the API and relay the complete sealed profile bytes
	// unchanged; enrolld never sees a device code.
	serialHash := h.hashSerial(cms.Signer.Subject.CommonName)
	resp, err := h.api.Finish(r.Context(), FinishRequest{
		CertDER: base64.StdEncoding.EncodeToString(cms.Signer.Raw),
		UDID:    optionalAttr(attrs["UDID"]),
	})
	dur := h.now().Sub(start).Round(time.Millisecond).String()
	if err != nil {
		h.log.Warn("enrollment request failed", "phase", 4, "outcome", "api_error",
			"serial_hmac", serialHash, "duration", dur)
		writeBareError(w, http.StatusServiceUnavailable)
		return
	}
	if resp.Outcome == "refused" {
		h.log.Info("enrollment request refused", "phase", 4, "outcome", "refused",
			"reason", clampLog(resp.Reason, 64), "serial_hmac", serialHash, "duration", dur)
		writeBareError(w, http.StatusBadRequest)
		return
	}

	writeMobileConfig(w, resp.ProfileBytes)
	h.log.Info("enrollment request handled", "phase", 4, "outcome", "sealed",
		"serial_hmac", serialHash, "duration", dur)
}

func (h *Handler) hashSerial(serial string) string {
	if serial == "" {
		return ""
	}
	mac := hmac.New(sha256.New, h.serialKey[:])
	_, _ = mac.Write([]byte(serial))
	sum := mac.Sum(nil)
	return hex.EncodeToString(sum[:serialHMACBytes])
}

func isValidToken(s string) bool {
	if len(s) != enrollTokenLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') ||
			(c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') ||
			c == '-' || c == '_' {
			continue
		}
		return false
	}
	return true
}

func optionalAttr(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}

func phaseNumber(p Phase) int {
	switch p {
	case Phase2Apple:
		return 2
	case Phase4DeviceCA:
		return 4
	default:
		return 0
	}
}

func clampLog(s string, max int) string {
	if len(s) > max {
		s = s[:max]
	}
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7F {
			return -1
		}
		return r
	}, s)
}

func writeMobileConfig(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", ContentTypeMobileConfig)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func writeBareError(w http.ResponseWriter, code int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
}
