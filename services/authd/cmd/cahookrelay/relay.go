package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/config"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
)

const (
	// maxBodyBytes caps incoming step-ca webhook bodies at 64 KiB.
	maxBodyBytes = 64 << 10

	// timestampWindow rejects stale or future-dated step-ca webhook payloads.
	timestampWindow = 60 * time.Second

	headerSmallstepID = "X-Smallstep-Webhook-ID"
)

var webhookIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

type scepConfig struct {
	Listen               string
	CertFile             string
	KeyFile              string
	WebhookIDsRaw        string
	WebhookIDs           map[string]string
	IntermediateNotAfter time.Time
	IntermediateRaw      string
	RedisURL             string
	RedisUser            string
	RedisPassword        string
	RedisTimeout         time.Duration
	LogLevel             string
}

func loadConfig() (scepConfig, error) {
	c := scepConfig{
		Listen:          config.Env("CAHOOKRELAY_LISTEN", "127.0.0.1:9443"),
		CertFile:        config.Env("CAHOOKRELAY_TLS_CERT_FILE", "/etc/cahookrelay/tls/tls.crt"),
		KeyFile:         config.Env("CAHOOKRELAY_TLS_KEY_FILE", "/etc/cahookrelay/tls/tls.key"),
		WebhookIDsRaw:   config.Env("CAHOOKRELAY_WEBHOOK_IDS", ""),
		IntermediateRaw: config.Env("CAHOOKRELAY_INTERMEDIATE_NOT_AFTER", ""),
		RedisURL:        strings.TrimSpace(os.Getenv("ENROLL_REDIS_URL")),
		RedisUser:       config.Env("ENROLL_REDIS_USER", "cahookrelay"),
		RedisPassword:   os.Getenv("ENROLL_REDIS_PASSWORD"),
		LogLevel:        config.Env("CAHOOKRELAY_LOG_LEVEL", "info"),
	}
	var err error
	if c.RedisTimeout, err = config.EnvDuration("CAHOOKRELAY_REDIS_TIMEOUT", 4*time.Second); err != nil {
		return c, err
	}
	return c, c.validate()
}

func (c *scepConfig) validate() error {
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
	if ids, err := parseWebhookIDs(c.WebhookIDsRaw); err != nil {
		errs = append(errs, fmt.Errorf("CAHOOKRELAY_WEBHOOK_IDS: %w", err))
	} else {
		c.WebhookIDs = ids
	}
	if at, ok := parseGoTime(strings.TrimSpace(c.IntermediateRaw)); !ok {
		errs = append(errs, errors.New("CAHOOKRELAY_INTERMEDIATE_NOT_AFTER must be an RFC 3339 timestamp with explicit timezone"))
	} else {
		c.IntermediateNotAfter = at
	}
	if c.RedisURL == "" {
		errs = append(errs, errors.New("ENROLL_REDIS_URL is required"))
	}
	if c.RedisPassword == "" {
		errs = append(errs, errors.New("ENROLL_REDIS_PASSWORD is required"))
	}
	if c.RedisTimeout < 500*time.Millisecond || c.RedisTimeout > 15*time.Second {
		errs = append(errs, fmt.Errorf("CAHOOKRELAY_REDIS_TIMEOUT is %s: keep it between 500ms and 15s", c.RedisTimeout))
	}
	return errors.Join(errs...)
}

func parseWebhookIDs(raw string) (map[string]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("required (scep-challenge=<id>,scep-authorize=<id>)")
	}
	required := map[string]bool{
		"scep-challenge": true,
		"scep-authorize": true,
	}
	ids := make(map[string]string, 2)
	seenVal := make(map[string]bool, 2)
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		kind, id, ok := strings.Cut(entry, "=")
		if !ok || strings.Contains(id, "=") || kind == "" || id == "" {
			return nil, errors.New("each entry must be <kind>=<id>")
		}
		if !required[kind] {
			return nil, fmt.Errorf("unknown hook kind %q (only scep-challenge, scep-authorize allowed)", kind)
		}
		if !webhookIDPattern.MatchString(id) {
			return nil, fmt.Errorf("invalid webhook id for %s", kind)
		}
		if _, dup := ids[kind]; dup {
			return nil, fmt.Errorf("%s listed twice", kind)
		}
		if seenVal[id] {
			return nil, errors.New("each hook kind must have its own distinct webhook id")
		}
		ids[kind] = id
		seenVal[id] = true
	}
	for k := range required {
		if _, ok := ids[k]; !ok {
			return nil, fmt.Errorf("missing %s", k)
		}
	}
	return ids, nil
}

// scepHookHandler handles step-ca's SCEPCHALLENGE and AUTHORIZING webhooks
// locally against i10-enroll-redis as the `cahookrelay` ACL user: read and
// write enroll:scep:*, read enroll:sess:*, nothing else.
//
// ⚠ WHAT A COMPROMISED RELAY CAN DO (main.go, design doc 6.5). It parses
// step-ca's webhook bodies, so treat it as able to send any command its ACL
// allows. IT CAN TAKE OVER AN ENROLLMENT THAT IS IN SCEP: step-ca sends it
// every in-flight challenge in plaintext, so it can bind a victim's enrollment
// to its own key, and enrollctl cannot tell that binding from the device's (a
// compromised step-ca can do the same). That is inherent to SCEP. What it
// cannot do: write a session (so it cannot attest one, change its challenge,
// serial or person, or touch one that is not in SCEP), bind a challenge whose
// plaintext it was never sent, or reach a sealed profile or a minted device.
// Beyond the takeover it can refuse or stall enrollments.
//
// NEVER LOGS WEBHOOK IDS, CHALLENGES, SERIALS, KEYS, OR REQUEST BODIES.
type scepHookHandler struct {
	store                enrollredis.Store
	webhookIDs           map[string]string
	intermediateNotAfter time.Time
	timeout              time.Duration
	now                  func() time.Time
	log                  *slog.Logger
}

func (h *scepHookHandler) currentNow() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

func sameTextConstTime(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

func (h *scepHookHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if rec := recover(); rec != nil {
			if h.log != nil {
				h.log.Error("scep hook panic recovered", "path", r.URL.Path)
			}
			w.WriteHeader(http.StatusInternalServerError)
		}
	}()

	if r.URL.RawQuery != "" || r.Method != http.MethodPost {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	var kind string
	switch r.URL.Path {
	case "/scep-challenge":
		kind = "scep-challenge"
	case "/scep-authorize":
		kind = "scep-authorize"
	default:
		w.WriteHeader(http.StatusNotFound)
		return
	}

	wantID := h.webhookIDs[kind]
	if !sameTextConstTime(r.Header.Get(headerSmallstepID), wantID) {
		if h.log != nil {
			h.log.Warn("scep hook rejected", "hook", kind, "outcome", "unauthenticated")
		}
		w.WriteHeader(http.StatusNotFound)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		return
	}

	now := h.currentNow()
	ts, ok := parseBodyTimestamp(body)
	if !ok {
		if h.log != nil {
			h.log.Warn("scep hook rejected", "hook", kind, "outcome", "stale_or_unreadable")
		}
		w.WriteHeader(http.StatusNotFound)
		return
	}
	delta := now.Sub(ts)
	if delta < -timestampWindow || delta > timestampWindow {
		if h.log != nil {
			h.log.Warn("scep hook rejected", "hook", kind, "outcome", "stale_or_unreadable")
		}
		w.WriteHeader(http.StatusNotFound)
		return
	}

	timeout := h.timeout
	if timeout <= 0 {
		timeout = 4 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	start := time.Now()
	var decision enrollredis.SCEPDecision
	switch kind {
	case "scep-challenge":
		decision, err = h.handleSCEPChallenge(ctx, body, now)
	case "scep-authorize":
		decision, err = h.handleSCEPAuthorize(ctx, body, now)
	}
	if err != nil {
		if h.log != nil {
			h.log.Error("scep hook failed", "hook", kind, "outcome", "redis_error",
				"duration", time.Since(start).Round(time.Millisecond).String())
		}
		// Fail closed on Redis errors; step-ca refuses issuance on 5xx.
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}

	if h.log != nil {
		h.log.Info("scep hook handled", "hook", kind, "outcome", decision.Outcome,
			"allow", decision.Allow, "duration", time.Since(start).Round(time.Millisecond).String())
	}
	writeAllowJSON(w, decision.Allow)
}

// handleSCEPChallenge claims the challenge for the CSR's key. A template
// refusal against a real challenge is recorded as the session's SCEP refusal
// (enroll:scep:refusal:<eid>) so the console shows it: cahookrelay may read
// sessions, never write them.
func (h *scepHookHandler) handleSCEPChallenge(ctx context.Context, body []byte, now time.Time) (enrollredis.SCEPDecision, error) {
	parsed, chalHex, refusal := parseSCEPChallengeBody(body)
	if refusal != "" {
		if refusal == "bad_template" && chalHex != "" {
			if chal, err := h.store.GetSCEPChallenge(ctx, chalHex); err == nil && chal != nil && chal.EID != "" {
				_ = h.store.MarkSCEPRefused(ctx, chal.EID, refusal)
			}
		}
		return enrollredis.SCEPDecision{Allow: false, Outcome: refusal}, nil
	}
	return h.store.SCEPClaim(ctx, parsed.Challenge, parsed.KeySHA256, parsed.TransactionID, parsed.CommonName, now)
}

// handleSCEPAuthorize allows issuance for a bound key; a template refusal is
// recorded the same way.
func (h *scepHookHandler) handleSCEPAuthorize(ctx context.Context, body []byte, now time.Time) (enrollredis.SCEPDecision, error) {
	parsed, keyHexHint, refusal := parseAndCheckSCEPAuthorize(body, now, h.intermediateNotAfter)
	if refusal != "" {
		if refusal == "bad_template" && keyHexHint != "" {
			if kb, err := h.store.GetSCEPKeyBinding(ctx, keyHexHint); err == nil && kb != nil && kb.EID != "" {
				_ = h.store.MarkSCEPRefused(ctx, kb.EID, refusal)
			}
		}
		return enrollredis.SCEPDecision{Allow: false, Outcome: refusal}, nil
	}
	return h.store.SCEPAuthorize(ctx, parsed.KeySHA256, parsed.CommonName, now)
}

func writeAllowJSON(w http.ResponseWriter, allow bool) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(struct {
		Allow bool `json:"allow"`
	}{Allow: allow})
}
