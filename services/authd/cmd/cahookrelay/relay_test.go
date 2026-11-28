package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis/redistest"
)

type lockedLog struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func generateTestSPKI(t *testing.T) (string, string) {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(der)
	return base64.StdEncoding.EncodeToString(der), hex.EncodeToString(sum[:])
}

// seedAttestedSession creates and attests a session as the API and enrollctl
// would, on the test Redis.
func seedAttestedSession(t *testing.T, store enrollredis.Store, now time.Time, eid, serial, challenge string) {
	t.Helper()
	chalHex := enrollredis.HashChallenge(challenge)
	sess := enrollredis.Session{
		ID:            eid,
		ClerkUserID:   "user_" + eid,
		Email:         "u@example.com",
		ExpectedEpoch: 1,
		CreatedBy:     "user_" + eid,
		Status:        "open",
		CreatedAtMs:   now.UnixMilli(),
		ExpiresAtMs:   now.Add(15 * time.Minute).UnixMilli(),
		UpdatedAtMs:   now.UnixMilli(),
	}
	if err := store.CreateSession(context.Background(), sess, now); err != nil {
		t.Fatal(err)
	}
	res, err := store.AttestSession(context.Background(), enrollredis.AttestInput{
		EID:               eid,
		Now:               now,
		Serial:            serial,
		UDIDSha256:        strings.Repeat("1", 64),
		AppleSignerSha256: strings.Repeat("2", 64),
		Product:           "iPhone17,2",
		OSVersion:         "22A3354",
		Platform:          "ios",
		NewChalHash:       chalHex,
	})
	if err != nil || res.Outcome != "scep" {
		t.Fatalf("AttestSession = (%+v, %v)", res, err)
	}
}

func validSCEPAuthorizePayload(now time.Time, cn, spkiB64 string) map[string]any {
	return map[string]any{
		"timestamp": now.UTC().Format(time.RFC3339Nano),
		"x509Certificate": map[string]any{
			"version": 3,
			"subject": map[string]any{
				"commonName": cn,
			},
			"keyUsage":           []string{"digitalSignature", "keyEncipherment"},
			"extKeyUsage":        []string{"emailProtection"},
			"publicKey":          spkiB64,
			"publicKeyAlgorithm": "RSA",
			"notBefore":          now.UTC().Format(time.RFC3339Nano),
			"notAfter":           now.UTC().Add(7 * 24 * time.Hour).Format(time.RFC3339Nano),
		},
	}
}

func postHook(h http.Handler, path, wid string, payload any) *httptest.ResponseRecorder {
	var body []byte
	switch v := payload.(type) {
	case string:
		body = []byte(v)
	case []byte:
		body = v
	default:
		body, _ = json.Marshal(v)
	}
	req := httptest.NewRequest(http.MethodPost, "https://127.0.0.1:9443"+path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if wid != "" {
		req.Header.Set(headerSmallstepID, wid)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeAllow(t *testing.T, rec *httptest.ResponseRecorder) bool {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%q)", rec.Code, rec.Body.String())
	}
	var out struct {
		Allow bool `json:"allow"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode allow JSON: %v (%q)", err, rec.Body.String())
	}
	return out.Allow
}

func TestSCEPChallengeAndAuthorizeHappyPathRetryConflictAndNoSecretLogs(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	store, _ := redistest.Open(t)
	logs := &lockedLog{}

	const (
		chalWID = "wh-scep-chal-secret-id"
		authWID = "wh-scep-auth-secret-id"
	)
	id := redistest.ID(t)
	secretCh := "one-time-scep-challenge-secret-" + id
	secretSer := "C02SECRET" + id[:6]
	txID := "tx-unique-" + id
	eid := "eid-" + id
	seedAttestedSession(t, store, now, eid, secretSer, secretCh)

	h := &scepHookHandler{
		store: store,
		webhookIDs: map[string]string{
			"scep-challenge": chalWID,
			"scep-authorize": authWID,
		},
		intermediateNotAfter: now.Add(365 * 24 * time.Hour),
		timeout:              2 * time.Second,
		now:                  func() time.Time { return now },
		log:                  slog.New(slog.NewJSONHandler(logs, nil)),
	}

	spkiB64, firstKeyHex := generateTestSPKI(t)
	spki2B64, _ := generateTestSPKI(t)

	chalReq := map[string]any{
		"timestamp":         now.Format(time.RFC3339Nano),
		"scepChallenge":     secretCh,
		"scepTransactionID": txID,
		"x509CertificateRequest": map[string]any{
			"subject":   map[string]any{"commonName": secretSer},
			"publicKey": spkiB64,
		},
	}

	// 1. First SCEPCHALLENGE succeeds.
	if !decodeAllow(t, postHook(h, "/scep-challenge", chalWID, chalReq)) {
		t.Fatal("first /scep-challenge refused")
	}

	// 2. Identical retry succeeds.
	if !decodeAllow(t, postHook(h, "/scep-challenge", chalWID, chalReq)) {
		t.Fatal("idempotent /scep-challenge retry refused")
	}

	// 3. SCEP AUTHORIZING with valid template succeeds + retry succeeds.
	authReq := validSCEPAuthorizePayload(now, secretSer, spkiB64)
	if !decodeAllow(t, postHook(h, "/scep-authorize", authWID, authReq)) {
		t.Fatal("first /scep-authorize refused")
	}
	if !decodeAllow(t, postHook(h, "/scep-authorize", authWID, authReq)) {
		t.Fatal("retry /scep-authorize refused")
	}

	// 4. Different key replaying same challenge is refused, and the refusal is
	// recorded for the console WITHOUT writing the session (read-only to the relay).
	conflictReq := map[string]any{
		"timestamp":         now.Format(time.RFC3339Nano),
		"scepChallenge":     secretCh,
		"scepTransactionID": txID,
		"x509CertificateRequest": map[string]any{
			"subject":   map[string]any{"commonName": secretSer},
			"publicKey": spki2B64,
		},
	}
	if decodeAllow(t, postHook(h, "/scep-challenge", chalWID, conflictReq)) {
		t.Fatal("conflicting key /scep-challenge was allowed")
	}
	if code, err := store.GetSCEPRefusal(context.Background(), eid); err != nil || code != "scep_key_conflict" {
		t.Fatalf("SCEP refusal after key conflict = (%q, %v)", code, err)
	}
	sess, err := store.GetSession(context.Background(), eid)
	if err != nil || sess == nil || sess.Status != "attested" {
		t.Fatalf("session after key conflict = %+v, err=%v (the relay must not write it)", sess, err)
	}
	kb, err := store.GetSCEPKeyBinding(context.Background(), firstKeyHex)
	if err != nil || kb == nil || kb.Challenge != secretCh || kb.EID != eid {
		t.Fatalf("key binding = (%+v, %v), want the challenge plaintext and the session id", kb, err)
	}

	// 5. Logs must never contain webhook IDs, challenge, serial, or SPKI.
	logText := logs.String()
	for _, secret := range []string{chalWID, authWID, secretCh, secretSer, spkiB64, txID} {
		if strings.Contains(logText, secret) {
			t.Fatalf("logs leaked %q:\n%s", secret, logText)
		}
	}
}

func TestSCEPTemplateRefusalsAreRecordedForTheConsole(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	interExpiry := now.Add(30 * 24 * time.Hour)

	// want is the refusal recorded for the console: bad_template for a
	// template rule; nothing for a body no x509util template produces
	// (bad_body), which names no key the relay can trust.
	subject := func(extra map[string]any) map[string]any {
		s := map[string]any{"commonName": "SER1"}
		for k, v := range extra {
			s[k] = v
		}
		return s
	}
	cases := []struct {
		name   string
		mutate func(cert map[string]any)
		want   string
	}{
		{"unknown JSON field rejected", func(c map[string]any) { c["unknownEvilField"] = true }, ""},
		{"rawSubject set", func(c map[string]any) { c["rawSubject"] = "AA==" }, "bad_template"},
		{"clientAuth EKU refused", func(c map[string]any) { c["extKeyUsage"] = []string{"clientAuth"} }, "bad_template"},
		{"empty EKU refused", func(c map[string]any) { c["extKeyUsage"] = []string{} }, "bad_template"},
		{"emailProtection + clientAuth refused", func(c map[string]any) { c["extKeyUsage"] = []string{"emailProtection", "clientAuth"} }, "bad_template"},
		{"unknown EKU refused", func(c map[string]any) { c["unknownExtKeyUsage"] = []string{"1.2.3.4"} }, "bad_template"},
		{"wrong keyUsage", func(c map[string]any) { c["keyUsage"] = []string{"digitalSignature"} }, "bad_template"},
		{"dnsNames set", func(c map[string]any) { c["dnsNames"] = []string{"evil.example"} }, "bad_template"},
		{"sans set", func(c map[string]any) { c["sans"] = []map[string]any{{"type": "permanentIdentifier", "value": "SER1"}} }, "bad_template"},
		{"extensions set", func(c map[string]any) {
			c["extensions"] = []map[string]any{{"id": "2.5.29.17", "critical": false, "value": "AA=="}}
		}, "bad_template"},
		{"isCA true", func(c map[string]any) { c["basicConstraints"] = map[string]any{"isCA": true} }, "bad_template"},
		{"notBefore stale", func(c map[string]any) { c["notBefore"] = now.Add(-10 * time.Minute).Format(time.RFC3339Nano) }, "bad_template"},
		{"notAfter exceeds 7d+5m", func(c map[string]any) { c["notAfter"] = now.Add(8 * 24 * time.Hour).Format(time.RFC3339Nano) }, "bad_template"},
		{"notAfter exceeds intermediate", func(c map[string]any) { c["notAfter"] = interExpiry.Add(time.Hour).Format(time.RFC3339Nano) }, "bad_template"},
		{"extraNames in subject", func(c map[string]any) {
			c["subject"] = subject(map[string]any{"extraNames": []any{map[string]any{"type": "2.5.4.3", "value": "X"}}})
		}, "bad_template"},
		{"OU in subject", func(c map[string]any) {
			c["subject"] = subject(map[string]any{"organizationalUnit": []string{"Sales"}})
		}, "bad_template"},
		{"O in subject", func(c map[string]any) { c["subject"] = subject(map[string]any{"organization": []string{"Evil Inc"}}) }, "bad_template"},
		{"C in subject", func(c map[string]any) { c["subject"] = subject(map[string]any{"country": []string{"US"}}) }, "bad_template"},
		{"L in subject", func(c map[string]any) { c["subject"] = subject(map[string]any{"locality": []string{"Cairo"}}) }, "bad_template"},
		{"ST in subject", func(c map[string]any) { c["subject"] = subject(map[string]any{"province": []string{"X"}}) }, "bad_template"},
		{"street in subject", func(c map[string]any) { c["subject"] = subject(map[string]any{"streetAddress": []string{"1 Main"}}) }, "bad_template"},
		{"postal code in subject", func(c map[string]any) { c["subject"] = subject(map[string]any{"postalCode": []string{"12345"}}) }, "bad_template"},
		{"serialNumber in subject", func(c map[string]any) { c["subject"] = subject(map[string]any{"serialNumber": "123"}) }, "bad_template"},
		{"unknown subject attribute", func(c map[string]any) { c["subject"] = subject(map[string]any{"evil": "x"}) }, ""},
		{"serialNumber set", func(c map[string]any) { c["serialNumber"] = "12345" }, ""},
		{"raw set", func(c map[string]any) { c["raw"] = "AA==" }, ""},
	}

	store, _ := redistest.Open(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			eid := "eid-" + redistest.ID(t)
			spkiB64, _ := generateTestSPKI(t) // one key per session: a key binds one challenge
			seedAttestedSession(t, store, now, eid, "SER1", "chal-"+eid)
			h := &scepHookHandler{
				store:                store,
				webhookIDs:           map[string]string{"scep-challenge": "w1", "scep-authorize": "w2"},
				intermediateNotAfter: interExpiry,
				now:                  func() time.Time { return now },
				log:                  slog.New(slog.NewTextHandler(io.Discard, nil)),
			}
			chalReq := map[string]any{
				"timestamp":         now.Format(time.RFC3339Nano),
				"scepChallenge":     "chal-" + eid,
				"scepTransactionID": "tx-" + eid,
				"x509CertificateRequest": map[string]any{
					"subject":   map[string]any{"commonName": "SER1"},
					"publicKey": spkiB64,
				},
			}
			if !decodeAllow(t, postHook(h, "/scep-challenge", "w1", chalReq)) {
				t.Fatal("challenge setup failed")
			}

			payload := validSCEPAuthorizePayload(now, "SER1", spkiB64)
			tc.mutate(payload["x509Certificate"].(map[string]any))

			if decodeAllow(t, postHook(h, "/scep-authorize", "w2", payload)) {
				t.Fatalf("%s: allowed", tc.name)
			}
			if code, err := store.GetSCEPRefusal(context.Background(), eid); err != nil || code != tc.want {
				t.Fatalf("%s: recorded refusal = (%q, %v), want %q", tc.name, code, err, tc.want)
			}
		})
	}
}

func TestWebhookAuthPathsTimestampAndOversize(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	h := &scepHookHandler{
		store:                failingStore{},
		webhookIDs:           map[string]string{"scep-challenge": "id-chal", "scep-authorize": "id-auth"},
		intermediateNotAfter: now.Add(365 * 24 * time.Hour),
		now:                  func() time.Time { return now },
		log:                  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	// Removed & unknown paths return 404.
	for _, p := range []string{"/", "/acme-authorize", "/scep-notify", "/health", "/scep-challenge?x=1", "/scep-authorize/extra"} {
		rec := postHook(h, p, "id-chal", `{"timestamp":"2026-11-27T12:00:00Z"}`)
		if rec.Code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 404", p, rec.Code)
		}
	}

	// Non-POST returns 404.
	req := httptest.NewRequest(http.MethodGet, "https://127.0.0.1:9443/scep-challenge", nil)
	req.Header.Set(headerSmallstepID, "id-chal")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /scep-challenge = %d, want 404", rec.Code)
	}

	// Wrong or missing webhook ID returns 404 (cannot replay authorize ID at challenge).
	for _, wid := range []string{"", "wrong", "id-auth"} {
		rec := postHook(h, "/scep-challenge", wid, `{"timestamp":"2026-11-27T12:00:00Z"}`)
		if rec.Code != http.StatusNotFound {
			t.Errorf("wid %q = %d, want 404", wid, rec.Code)
		}
	}

	// Stale timestamp (>60s) returns 404.
	stale := `{"timestamp":"` + now.Add(-61*time.Second).Format(time.RFC3339) + `"}`
	if rec := postHook(h, "/scep-challenge", "id-chal", stale); rec.Code != http.StatusNotFound {
		t.Errorf("stale timestamp = %d, want 404", rec.Code)
	}

	// Oversized body > 64 KiB returns 413.
	if rec := postHook(h, "/scep-challenge", "id-chal", make([]byte, maxBodyBytes+1)); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("oversized body = %d, want 413", rec.Code)
	}
}

type failingStore struct {
	enrollredis.Store
}

func (failingStore) SCEPClaim(context.Context, string, string, string, string, time.Time) (enrollredis.SCEPDecision, error) {
	return enrollredis.SCEPDecision{}, errors.New("redis down")
}

func TestRedisErrorFailsClosed503(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	spkiB64, _ := generateTestSPKI(t)
	h := &scepHookHandler{
		store:                failingStore{},
		webhookIDs:           map[string]string{"scep-challenge": "id-chal", "scep-authorize": "id-auth"},
		intermediateNotAfter: now.Add(365 * 24 * time.Hour),
		now:                  func() time.Time { return now },
		log:                  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	chalReq := map[string]any{
		"timestamp":         now.Format(time.RFC3339Nano),
		"scepChallenge":     "chal-1",
		"scepTransactionID": "tx-1",
		"x509CertificateRequest": map[string]any{
			"subject":   map[string]any{"commonName": "SER1"},
			"publicKey": spkiB64,
		},
	}
	rec := postHook(h, "/scep-challenge", "id-chal", chalReq)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("redis error status = %d, want 503", rec.Code)
	}
}

func TestConfigValidation(t *testing.T) {
	valid := func() scepConfig {
		return scepConfig{
			Listen:          "127.0.0.1:9443",
			CertFile:        "/etc/cahookrelay/tls/tls.crt",
			KeyFile:         "/etc/cahookrelay/tls/tls.key",
			WebhookIDsRaw:   "scep-challenge=wh1,scep-authorize=wh2",
			IntermediateRaw: "2036-11-26T00:00:00Z",
			RedisURL:        "redis://i10-enroll-redis.i10-prod.svc:6379",
			RedisUser:       "cahookrelay",
			RedisPassword:   "redis-password",
			RedisTimeout:    4 * time.Second,
		}
	}
	c0 := valid()
	if err := c0.validate(); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
	for name, mutate := range map[string]func(*scepConfig){
		"wildcard listen":      func(c *scepConfig) { c.Listen = "0.0.0.0:9443" },
		"non-loopback listen":  func(c *scepConfig) { c.Listen = "10.0.0.5:9443" },
		"missing cert":         func(c *scepConfig) { c.CertFile = "" },
		"missing webhook IDs":  func(c *scepConfig) { c.WebhookIDsRaw = "" },
		"duplicate webhook ID": func(c *scepConfig) { c.WebhookIDsRaw = "scep-challenge=same,scep-authorize=same" },
		"unknown webhook kind": func(c *scepConfig) { c.WebhookIDsRaw = "acme-authorize=a,scep-challenge=b,scep-authorize=c" },
		"bad intermediate ts":  func(c *scepConfig) { c.IntermediateRaw = "2036-11-26" },
		"missing redis url":    func(c *scepConfig) { c.RedisURL = "" },
		"missing redis pass":   func(c *scepConfig) { c.RedisPassword = "" },
		"timeout too short":    func(c *scepConfig) { c.RedisTimeout = 100 * time.Millisecond },
		"timeout too long":     func(c *scepConfig) { c.RedisTimeout = time.Minute },
	} {
		t.Run(name, func(t *testing.T) {
			c := valid()
			mutate(&c)
			if err := c.validate(); err == nil {
				t.Errorf("%s: accepted", name)
			}
		})
	}
}
