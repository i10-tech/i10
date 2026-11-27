package enroll

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/smallstep/pkcs7"
)

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type fakeAPIState struct {
	mu         sync.Mutex
	peekCalls  int
	peekStatus int
	peekBody   string

	attestCalls   int
	attestStatus  int
	attestBody    string
	lastAttest    AttestRequest
	lastAttestRaw string

	finishCalls   int
	finishStatus  int
	finishBody    string
	lastFinish    FinishRequest
	lastFinishRaw string

	delay time.Duration
	gate  chan struct{}
}

func newHandlerFixture(t *testing.T, maxConcurrent int) (*Handler, *testPKI, *fakeAPIState, *lockedBuffer) {
	t.Helper()
	pki := newTestPKI(t)
	withFakeAppleCAs(t, pki.appleCA1.cert)

	state := &fakeAPIState{
		peekStatus:   http.StatusOK,
		peekBody:     `{"live":true}`,
		attestStatus: http.StatusOK,
		attestBody:   `{"outcome":"scep","serial":"C02SECRET999","challenge":"scep-one-time-secret-chal"}`,
		finishStatus: http.StatusOK,
		finishBody:   `{"outcome":"sealed","profile":"` + base64.StdEncoding.EncodeToString([]byte("OPAQUE-SEALED-PROFILE-CODE-SECRET-XYZ")) + `"}`,
	}

	const apiBearer = "enrolld-secret-bearer-token-value"
	apiSrv := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+apiBearer {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		raw, _ := io.ReadAll(r.Body)

		state.mu.Lock()
		gate := state.gate
		delay := state.delay
		state.mu.Unlock()
		if gate != nil {
			<-gate
		}
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}

		state.mu.Lock()
		defer state.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/enrolld/peek":
			state.peekCalls++
			w.WriteHeader(state.peekStatus)
			_, _ = w.Write([]byte(state.peekBody))
		case "/enrolld/attest":
			state.attestCalls++
			state.lastAttestRaw = string(raw)
			_ = json.Unmarshal(raw, &state.lastAttest)
			w.WriteHeader(state.attestStatus)
			_, _ = w.Write([]byte(state.attestBody))
		case "/enrolld/finish":
			state.finishCalls++
			state.lastFinishRaw = string(raw)
			_ = json.Unmarshal(raw, &state.lastFinish)
			w.WriteHeader(state.finishStatus)
			_, _ = w.Write([]byte(state.finishBody))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	client, err := NewAPIClient(apiSrv.server.URL, apiSrv.caFile, apiBearer, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedBuffer{}
	h, err := NewHandler(HandlerConfig{
		API:           client,
		Trust:         func() *DeviceTrust { return pki.trust },
		ProfileURL:    "https://ca.i10.tech/enroll/apple/profile",
		SCEPURL:       "https://ca.i10.tech/scep/apple-scep",
		MaxConcurrent: maxConcurrent,
		Log:           slog.New(slog.NewJSONHandler(logs, nil)),
		Now:           func() time.Time { return pki.now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return h, pki, state, logs
}

func makePhase2Plist(challengeTag, challengeVal, udid, serial, product, version, deviceName, model string) []byte {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>`)
	b.WriteString(`<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`)
	b.WriteString(`<plist version="1.0"><dict>`)
	if challengeVal != "" {
		if challengeTag == "data" {
			fmt.Fprintf(&b, `<key>CHALLENGE</key><data>%s</data>`, base64.StdEncoding.EncodeToString([]byte(challengeVal)))
		} else {
			fmt.Fprintf(&b, `<key>CHALLENGE</key><string>%s</string>`, challengeVal)
		}
	}
	if udid != "" {
		fmt.Fprintf(&b, `<key>UDID</key><string>%s</string>`, udid)
	}
	if serial != "" {
		fmt.Fprintf(&b, `<key>SERIAL</key><string>%s</string>`, serial)
	}
	if product != "" {
		fmt.Fprintf(&b, `<key>PRODUCT</key><string>%s</string>`, product)
	}
	if version != "" {
		fmt.Fprintf(&b, `<key>VERSION</key><string>%s</string>`, version)
	}
	if deviceName != "" {
		fmt.Fprintf(&b, `<key>DEVICE_NAME</key><string>%s</string>`, deviceName)
	}
	if model != "" {
		fmt.Fprintf(&b, `<key>MODEL</key><string>%s</string>`, model)
	}
	b.WriteString(`</dict></plist>`)
	return []byte(b.String())
}

func TestHandlerRoutingAndHealthz(t *testing.T) {
	h, _, state, _ := newHandlerFixture(t, 4)
	validTok := "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"

	// /healthz returns bare 200 and leaks nothing.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("GET /healthz = (%d, %q), want (200, empty)", rec.Code, rec.Body.String())
	}

	notFoundCases := []struct {
		method string
		target string
	}{
		{http.MethodPost, "/healthz"},
		{http.MethodGet, "/healthz?x=1"},
		{http.MethodGet, "/"},
		{http.MethodGet, "/enroll"},
		{http.MethodGet, "/enroll/apple"},
		{http.MethodGet, "/enroll/apple/"},
		{http.MethodGet, "/enroll/apple/profile"}, // 7 chars != 43
		{http.MethodGet, "/enroll/apple/short"},
		{http.MethodGet, "/enroll/apple/" + validTok + "X"},          // 44 chars
		{http.MethodGet, "/enroll/apple/" + strings.Repeat("+", 43)}, // '+' is not base64url
		{http.MethodGet, "/enroll/apple/" + validTok + "/extra"},     // extra path segment
		{http.MethodGet, "/enroll/apple/" + validTok + "?q=1"},       // query string
		{http.MethodPost, "/enroll/apple/" + validTok},               // wrong method
		{http.MethodPut, "/enroll/apple/profile"},                    // wrong method
		{http.MethodPost, "/enroll/apple/profile?q=1"},               // query string
		{http.MethodGet, "/enroll/apple/%2e%2e/secret"},              // percent-encoded traversal
		{http.MethodPost, "/enrolld/peek"},                           // internal API path
	}
	for _, tc := range notFoundCases {
		t.Run(tc.method+" "+tc.target, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.target, nil)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s %s = %d, want 404", tc.method, tc.target, rec.Code)
			}
		})
	}
	if state.peekCalls != 0 || state.attestCalls != 0 || state.finishCalls != 0 {
		t.Fatalf("invalid routes called API: peek=%d attest=%d finish=%d", state.peekCalls, state.attestCalls, state.finishCalls)
	}
}

func TestHandlerPhase1(t *testing.T) {
	validTok := "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"

	t.Run("live returns phase 1 mobileconfig", func(t *testing.T) {
		h, _, state, _ := newHandlerFixture(t, 4)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/enroll/apple/"+validTok, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != ContentTypeMobileConfig {
			t.Fatalf("Content-Type = %q, want %q", ct, ContentTypeMobileConfig)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", cc)
		}
		if !strings.Contains(rec.Body.String(), "<key>Challenge</key>\n    <string>"+validTok+"</string>") {
			t.Fatalf("missing challenge in profile:\n%s", rec.Body.String())
		}
		if state.peekCalls != 1 {
			t.Fatalf("peekCalls = %d, want 1", state.peekCalls)
		}
	})

	t.Run("not live returns 404", func(t *testing.T) {
		h, _, state, _ := newHandlerFixture(t, 4)
		state.peekBody = `{"live":false}`
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/enroll/apple/"+validTok, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
	})

	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"API 404 auth failure", http.StatusNotFound, ""},
		{"API 500 fault", http.StatusInternalServerError, `{"error":"db"}`},
		{"API malformed JSON", http.StatusOK, `{`},
	} {
		t.Run(tc.name+" returns 503", func(t *testing.T) {
			h, _, state, _ := newHandlerFixture(t, 4)
			state.peekStatus = tc.status
			state.peekBody = tc.body
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/enroll/apple/"+validTok, nil))
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", rec.Code)
			}
		})
	}
}

func TestHandlerPhase2AndPhase4EndToEndAndLogRedaction(t *testing.T) {
	h, pki, state, logs := newHandlerFixture(t, 4)
	validTok := "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"
	const (
		secretUDID       = "00008140-SECRET-UDID-9999"
		secretSerial     = "C02SECRET999"
		secretDeviceName = "Mohameds Secret MacBook"
		secretModel      = "MacBookProSecretModel"
		secretVersion    = "24B83-SECRET"
	)

	// 1. Phase 1 GET.
	rec1 := httptest.NewRecorder()
	h.ServeHTTP(rec1, httptest.NewRequest(http.MethodGet, "/enroll/apple/"+validTok, nil))
	if rec1.Code != http.StatusOK {
		t.Fatalf("phase 1 = %d", rec1.Code)
	}

	// 2. Phase 2 POST with CHALLENGE as <string> and all optional attributes.
	appleLeaf := pki.issueAppleLeaf(t, pki.appleCA1, "apple-device", x509.SHA1WithRSA, 1024, nil)
	p2Plist := makePhase2Plist("string", validTok, secretUDID, secretSerial, "MacBookPro18,3", secretVersion, secretDeviceName, secretModel)
	p2CMS := signWithPKCS7(t, appleLeaf, pkcs7.OIDDigestAlgorithmSHA1, p2Plist)

	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(p2CMS)))
	if rec2.Code != http.StatusOK {
		t.Fatalf("phase 2 = %d", rec2.Code)
	}
	if ct := rec2.Header().Get("Content-Type"); ct != ContentTypeMobileConfig {
		t.Fatalf("phase 2 Content-Type = %q", ct)
	}
	if !strings.Contains(rec2.Body.String(), "<key>KeyIsExtractable</key>\n        <false/>") {
		t.Fatalf("phase 2 missing KeyIsExtractable false:\n%s", rec2.Body.String())
	}
	if !strings.Contains(rec2.Body.String(), "scep-one-time-secret-chal") {
		t.Fatalf("phase 2 missing SCEP challenge")
	}
	wantSignerHash := sha256.Sum256(appleLeaf.cert.Raw)
	if state.lastAttest.AppleSignerSHA256 != hex.EncodeToString(wantSignerHash[:]) {
		t.Fatalf("appleSignerSha256 = %q, want %x", state.lastAttest.AppleSignerSHA256, wantSignerHash)
	}
	if state.lastAttest.DeviceName == nil || *state.lastAttest.DeviceName != secretDeviceName {
		t.Fatalf("deviceName = %v", state.lastAttest.DeviceName)
	}
	if state.lastAttest.Model == nil || *state.lastAttest.Model != secretModel {
		t.Fatalf("model = %v", state.lastAttest.Model)
	}

	// 2b. Phase 2 POST with CHALLENGE as <data> and omitted optional attributes -> null in JSON.
	p2DataPlist := makePhase2Plist("data", validTok, secretUDID, secretSerial, "iPhone17,2", secretVersion, "", "")
	p2DataCMS := signWithPKCS7(t, appleLeaf, pkcs7.OIDDigestAlgorithmSHA256, p2DataPlist)
	rec2b := httptest.NewRecorder()
	h.ServeHTTP(rec2b, httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(p2DataCMS)))
	if rec2b.Code != http.StatusOK {
		t.Fatalf("phase 2 (<data> challenge) = %d", rec2b.Code)
	}
	if !strings.Contains(state.lastAttestRaw, `"deviceName":null`) || !strings.Contains(state.lastAttestRaw, `"model":null`) {
		t.Fatalf("expected null optional fields, got %s", state.lastAttestRaw)
	}

	// 3. Phase 4 POST signed by SCEP cert issued by device intermediate.
	scepLeaf := pki.issueSCEPLeaf(t, pki.deviceInter, secretSerial, nil)
	p4Plist := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>UDID</key><string>` + secretUDID + `</string></dict></plist>`)
	p4CMS := signWithPKCS7(t, scepLeaf, pkcs7.OIDDigestAlgorithmSHA256, p4Plist)

	rec4 := httptest.NewRecorder()
	h.ServeHTTP(rec4, httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(p4CMS)))
	if rec4.Code != http.StatusOK {
		t.Fatalf("phase 4 = %d", rec4.Code)
	}
	if ct := rec4.Header().Get("Content-Type"); ct != ContentTypeMobileConfig {
		t.Fatalf("phase 4 Content-Type = %q", ct)
	}
	if rec4.Body.String() != "OPAQUE-SEALED-PROFILE-CODE-SECRET-XYZ" {
		t.Fatalf("phase 4 did not relay sealed profile bytes verbatim: %q", rec4.Body.String())
	}
	wantCertDER := base64.StdEncoding.EncodeToString(scepLeaf.cert.Raw)
	if state.lastFinish.CertDER != wantCertDER {
		t.Fatalf("finish certDer mismatch")
	}
	if state.lastFinish.UDID == nil || *state.lastFinish.UDID != secretUDID {
		t.Fatalf("finish udid = %v", state.lastFinish.UDID)
	}

	// 3b. Phase 4 POST without UDID (empty dict) -> udid: null.
	p4Empty := signWithPKCS7(t, scepLeaf, pkcs7.OIDDigestAlgorithmSHA256, []byte(`<plist version="1.0"><dict/></plist>`))
	rec4b := httptest.NewRecorder()
	h.ServeHTTP(rec4b, httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(p4Empty)))
	if rec4b.Code != http.StatusOK {
		t.Fatalf("phase 4 empty dict = %d", rec4b.Code)
	}
	if !strings.Contains(state.lastFinishRaw, `"udid":null`) {
		t.Fatalf("expected udid:null, got %s", state.lastFinishRaw)
	}

	// 4. Verify strict log redaction across every log line emitted so far.
	logText := logs.String()
	for _, forbidden := range []string{
		"enrolld-secret-bearer-token-value",
		validTok,
		"scep-one-time-secret-chal",
		secretUDID,
		secretSerial,
		secretDeviceName,
		secretModel,
		secretVersion,
		"OPAQUE-SEALED-PROFILE-CODE-SECRET-XYZ",
	} {
		if strings.Contains(logText, forbidden) {
			t.Fatalf("logs leaked %q:\n%s", forbidden, logText)
		}
	}
	// Keyed serial HMAC must appear and be identical for phase 2 and phase 4 in
	// this process, and distinct in another Handler instance.
	wantHMAC := h.hashSerial(secretSerial)
	if len(wantHMAC) != serialHMACBytes*2 {
		t.Fatalf("serial HMAC length = %d, want %d", len(wantHMAC), serialHMACBytes*2)
	}
	if strings.Count(logText, wantHMAC) < 3 {
		t.Fatalf("expected keyed serial_hmac %q in phase 2 and phase 4 logs:\n%s", wantHMAC, logText)
	}
	if !strings.Contains(logText, `"product":"MacBookPro18,3"`) {
		t.Fatalf("expected product in phase 2 logs:\n%s", logText)
	}
	h2, _, _, _ := newHandlerFixture(t, 2)
	if h2.hashSerial(secretSerial) == wantHMAC {
		t.Fatal("two handlers produced identical serial HMAC (per-process random key failed)")
	}
}

func TestHandlerRefusalsAndFaults(t *testing.T) {
	validTok := "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"

	h, pki, state, _ := newHandlerFixture(t, 4)
	appleLeaf := pki.issueAppleLeaf(t, pki.appleCA1, "apple-dev", x509.SHA256WithRSA, 2048, nil)
	scepLeaf := pki.issueSCEPLeaf(t, pki.deviceInter, "C02SER", nil)
	decrypter := pki.issueSCEPLeaf(t, pki.deviceRoot, "decrypter", func(c *x509.Certificate) { c.ExtKeyUsage = nil })
	acmeLike := pki.issueSCEPLeaf(t, pki.deviceInter, "C02ACME", func(c *x509.Certificate) {
		c.ExtraExtensions = []pkix.Extension{permanentIdentifierSANExt(t, "C02ACME")}
	})

	p2Valid := signWithPKCS7(t, appleLeaf, pkcs7.OIDDigestAlgorithmSHA256,
		makePhase2Plist("string", validTok, "U1", "C02SER", "iPhone17,2", "22A3354", "", ""))
	p4Valid := signWithPKCS7(t, scepLeaf, pkcs7.OIDDigestAlgorithmSHA256,
		[]byte(`<plist version="1.0"><dict><key>UDID</key><string>U1</string></dict></plist>`))

	// Table of 400 / 413 refusals (no API call needed for local validation failures).
	localCases := []struct {
		name     string
		body     []byte
		wantCode int
	}{
		{"body over 64 KiB", bytes.Repeat([]byte("A"), MaxBodyBytes+1), http.StatusRequestEntityTooLarge},
		{"empty body", nil, http.StatusBadRequest},
		{"garbage bytes", []byte("not cms"), http.StatusBadRequest},
		{"decrypter cert rejected", signWithPKCS7(t, decrypter, pkcs7.OIDDigestAlgorithmSHA256, []byte(`<plist version="1.0"><dict/></plist>`)), http.StatusBadRequest},
		{"ACME otherName SAN rejected", signWithPKCS7(t, acmeLike, pkcs7.OIDDigestAlgorithmSHA256, []byte(`<plist version="1.0"><dict/></plist>`)), http.StatusBadRequest},
		{"phase 2 bad plist", signWithPKCS7(t, appleLeaf, pkcs7.OIDDigestAlgorithmSHA256, []byte(`<plist version="1.0"><dict><key>A</key><integer>1</integer></dict></plist>`)), http.StatusBadRequest},
		{"phase 2 missing SERIAL", signWithPKCS7(t, appleLeaf, pkcs7.OIDDigestAlgorithmSHA256, makePhase2Plist("string", validTok, "U1", "", "iPhone17,2", "22A3354", "", "")), http.StatusBadRequest},
		{"phase 2 malformed token", signWithPKCS7(t, appleLeaf, pkcs7.OIDDigestAlgorithmSHA256, makePhase2Plist("string", "too-short", "U1", "C02SER", "iPhone17,2", "22A3354", "", "")), http.StatusBadRequest},
		{"phase 4 bad plist", signWithPKCS7(t, scepLeaf, pkcs7.OIDDigestAlgorithmSHA256, []byte(`<notplist/>`)), http.StatusBadRequest},
	}
	for _, tc := range localCases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(tc.body)))
			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantCode)
			}
		})
	}
	if state.attestCalls != 0 || state.finishCalls != 0 {
		t.Fatalf("local refusals called API: attest=%d finish=%d", state.attestCalls, state.finishCalls)
	}

	// API refusal (200 outcome=refused) -> 400; API 404/500/timeout -> 503.
	apiCases := []struct {
		name     string
		body     []byte
		setup    func(*fakeAPIState)
		wantCode int
	}{
		{
			name: "phase 2 API refused -> 400",
			body: p2Valid,
			setup: func(s *fakeAPIState) {
				s.attestStatus = 200
				s.attestBody = `{"outcome":"refused","reason":"macos_too_old"}`
			},
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "phase 2 API 404 -> 503",
			body:     p2Valid,
			setup:    func(s *fakeAPIState) { s.attestStatus = 404; s.attestBody = "" },
			wantCode: http.StatusServiceUnavailable,
		},
		{
			name:     "phase 2 API 500 -> 503",
			body:     p2Valid,
			setup:    func(s *fakeAPIState) { s.attestStatus = 500; s.attestBody = "" },
			wantCode: http.StatusServiceUnavailable,
		},
		{
			name: "phase 4 API refused -> 400",
			body: p4Valid,
			setup: func(s *fakeAPIState) {
				s.finishStatus = 200
				s.finishBody = `{"outcome":"refused","reason":"permit_expired"}`
			},
			wantCode: http.StatusBadRequest,
		},
		{
			name:     "phase 4 API 404 -> 503",
			body:     p4Valid,
			setup:    func(s *fakeAPIState) { s.finishStatus = 404; s.finishBody = "" },
			wantCode: http.StatusServiceUnavailable,
		},
		{
			name:     "phase 4 API 502 -> 503",
			body:     p4Valid,
			setup:    func(s *fakeAPIState) { s.finishStatus = 502; s.finishBody = "" },
			wantCode: http.StatusServiceUnavailable,
		},
	}
	for _, tc := range apiCases {
		t.Run(tc.name, func(t *testing.T) {
			state.mu.Lock()
			tc.setup(state)
			state.mu.Unlock()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(tc.body)))
			if rec.Code != tc.wantCode {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantCode)
			}
		})
	}
}

func TestHandlerConcurrencyLimitAndHealthzBypass(t *testing.T) {
	h, _, state, _ := newHandlerFixture(t, 1)
	validTok := "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"

	gate := make(chan struct{})
	state.mu.Lock()
	state.gate = gate
	state.mu.Unlock()

	done := make(chan int, 1)
	go func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/enroll/apple/"+validTok, nil))
		done <- rec.Code
	}()

	// Wait until the first request holds the single semaphore slot.
	deadline := time.Now().Add(2 * time.Second)
	for len(h.sem) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(h.sem) != 1 {
		close(gate)
		t.Fatal("first request did not acquire concurrency slot")
	}

	// Second enrollment request is rejected immediately with 503.
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/enroll/apple/"+validTok, nil))
	if rec2.Code != http.StatusServiceUnavailable {
		close(gate)
		t.Fatalf("concurrent overflow = %d, want 503", rec2.Code)
	}

	// /healthz still returns 200 while enrollment slots are full.
	recH := httptest.NewRecorder()
	h.ServeHTTP(recH, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if recH.Code != http.StatusOK {
		close(gate)
		t.Fatalf("/healthz under saturation = %d, want 200", recH.Code)
	}

	close(gate)
	if code := <-done; code != http.StatusOK {
		t.Fatalf("first request = %d, want 200", code)
	}
}

func TestHandlerAPITimeoutReturns503(t *testing.T) {
	h, pki, state, _ := newHandlerFixture(t, 4)
	validTok := "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"
	state.delay = 500 * time.Millisecond

	appleLeaf := pki.issueAppleLeaf(t, pki.appleCA1, "apple-dev", x509.SHA256WithRSA, 2048, nil)
	scepLeaf := pki.issueSCEPLeaf(t, pki.deviceInter, "C02SER", nil)
	p2Valid := signWithPKCS7(t, appleLeaf, pkcs7.OIDDigestAlgorithmSHA256,
		makePhase2Plist("string", validTok, "U1", "C02SER", "iPhone17,2", "22A3354", "", ""))
	p4Valid := signWithPKCS7(t, scepLeaf, pkcs7.OIDDigestAlgorithmSHA256,
		[]byte(`<plist version="1.0"><dict/></plist>`))

	for _, tc := range []struct {
		name string
		req  func() *http.Request
	}{
		{"phase 1 timeout", func() *http.Request { return httptest.NewRequest(http.MethodGet, "/enroll/apple/"+validTok, nil) }},
		{"phase 2 timeout", func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(p2Valid))
		}},
		{"phase 4 timeout", func() *http.Request {
			return httptest.NewRequest(http.MethodPost, "/enroll/apple/profile", bytes.NewReader(p4Valid))
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := tc.req()
			ctx, cancel := context.WithTimeout(req.Context(), 50*time.Millisecond)
			defer cancel()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req.WithContext(ctx))
			if rec.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503", rec.Code)
			}
		})
	}
}
