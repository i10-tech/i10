package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/mailfront"
)

type testPKI struct {
	caPEM   []byte
	certPEM []byte
	keyPEM  []byte
	tlsCert tls.Certificate
}

func makeLoopbackPKI(t *testing.T, cn string) testPKI {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: cn + " CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, _ := x509.ParseCertificate(caDER)

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: cn},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	tc, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return testPKI{caPEM: caPEM, certPEM: certPEM, keyPEM: keyPEM, tlsCert: tc}
}

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

func newHTTPSUpstream(t *testing.T, pki testPKI, handler http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(handler)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{pki.tlsCert}, MinVersion: tls.VersionTLS12}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

func TestRelayForwardsFourPathsWithAuthAndHeadersAndLogsNoSecrets(t *testing.T) {
	upstreamPKI := makeLoopbackPKI(t, "i10-api-ca-hooks")
	const (
		secretToken = "super-secret-bearer-token-9999"
		sigValue    = "deadbeefcafebabe1234567890"
		webhookID   = "wh-unique-id-42"
		reqSecret   = `{"serial":"SECRET-SERIAL-XYZ"}`
		respSecret  = `{"allow":true,"note":"SECRET-RESPONSE-ABC"}`
	)

	var (
		mu       sync.Mutex
		gotPath  string
		gotAuth  string
		gotSig   string
		gotWID   string
		gotExtra string
		gotBody  string
		calls    int
	)
	upstream := newHTTPSUpstream(t, upstreamPKI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		calls++
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotSig = r.Header.Get(headerSmallstepSig)
		gotWID = r.Header.Get(headerSmallstepID)
		gotExtra = r.Header.Get("X-Client-Cookie")
		gotBody = string(b)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(respSecret))
	}))

	dir := t.TempDir()
	caPath := filepath.Join(dir, "upstream-ca.pem")
	if err := os.WriteFile(caPath, upstreamPKI.caPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	tokPath := filepath.Join(dir, "token")
	if err := os.WriteFile(tokPath, []byte("  "+secretToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tf := &tokenFile{File: tokPath}
	if err := tf.Load(); err != nil {
		t.Fatal(err)
	}
	client, err := newUpstreamClient(caPath, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	logs := &lockedLog{}
	relay := &hookRelay{
		upstreamBase: upstream.URL,
		token:        tf.Get,
		client:       client,
		log:          slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}

	// Serve over real TLS with cert carrying IP:127.0.0.1 and DNS:localhost.
	relayPKI := makeLoopbackPKI(t, "cahookrelay")
	certPath := filepath.Join(dir, "tls.crt")
	keyPath := filepath.Join(dir, "tls.key")
	if err := os.WriteFile(certPath, relayPKI.certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, relayPKI.keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	cf := &mailfront.CertFiles{CertFile: certPath, KeyFile: keyPath}
	if err := cf.Load(); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	tlsLn := tls.NewListener(ln, mailfront.TLSConfig(cf))
	relaySrv := &http.Server{Handler: relay}
	go func() { _ = relaySrv.Serve(tlsLn) }()
	t.Cleanup(func() { _ = relaySrv.Close() })
	relayURL := "https://" + ln.Addr().String()

	relayRoots := x509.NewCertPool()
	relayRoots.AppendCertsFromPEM(relayPKI.caPEM)
	stepClient := &http.Client{
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: relayRoots, MinVersion: tls.VersionTLS12}},
	}

	for _, path := range []string{"/acme-authorize", "/scep-challenge", "/scep-authorize", "/scep-notify"} {
		req, _ := http.NewRequest(http.MethodPost, relayURL+path, strings.NewReader(reqSecret))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(headerSmallstepSig, sigValue)
		req.Header.Set(headerSmallstepID, webhookID)
		req.Header.Set("Authorization", "Bearer client-forged")
		req.Header.Set("X-Client-Cookie", "drop-me")
		resp, err := stepClient.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		out, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated || string(out) != respSecret {
			t.Fatalf("%s: status=%d body=%q", path, resp.StatusCode, string(out))
		}
		mu.Lock()
		if gotPath != path || gotAuth != "Bearer "+secretToken || gotSig != sigValue ||
			gotWID != webhookID || gotExtra != "" || gotBody != reqSecret {
			t.Fatalf("%s upstream saw path=%q auth=%q sig=%q wid=%q extra=%q body=%q",
				path, gotPath, gotAuth, gotSig, gotWID, gotExtra, gotBody)
		}
		mu.Unlock()
	}

	// Token rotation via file reload.
	const rotatedToken = "rotated-token-5555"
	if err := os.WriteFile(tokPath, []byte(rotatedToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := tf.Load(); err != nil {
		t.Fatal(err)
	}
	resp, err := stepClient.Post(relayURL+"/acme-authorize", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	mu.Lock()
	if gotAuth != "Bearer "+rotatedToken {
		t.Fatalf("after reload auth=%q, want rotated token", gotAuth)
	}
	mu.Unlock()

	// Logs must never contain tokens, bodies, or Smallstep headers.
	logText := logs.String()
	for _, sensitive := range []string{secretToken, rotatedToken, sigValue, webhookID, "SECRET-SERIAL-XYZ", "SECRET-RESPONSE-ABC"} {
		if strings.Contains(logText, sensitive) {
			t.Fatalf("log leaked sensitive value %q:\n%s", sensitive, logText)
		}
	}
}

func TestRelayRejectsUnknownPathsMethodsQueriesAndOversizedBodies(t *testing.T) {
	upstreamPKI := makeLoopbackPKI(t, "upstream")
	calls := 0
	upstream := newHTTPSUpstream(t, upstreamPKI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	caPath := filepath.Join(t.TempDir(), "ca.pem")
	_ = os.WriteFile(caPath, upstreamPKI.caPEM, 0o600)
	client, err := newUpstreamClient(caPath, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	relay := &hookRelay{
		upstreamBase: upstream.URL,
		token:        func() string { return "tok" },
		client:       client,
		log:          slog.New(slog.NewTextHandler(io.Discard, nil)),
	}

	// Unknown paths and query strings get 404.
	for _, p := range []string{"/", "/provisioners", "/health", "/acme-authorize/extra", "/acme-authorize?x=1", "/scep-notify/"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "https://127.0.0.1:9443"+p, strings.NewReader("{}"))
		relay.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("POST %s = %d, want 404", p, rec.Code)
		}
	}

	// Non-POST methods on allowed path get 405.
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(m, "https://127.0.0.1:9443/acme-authorize", nil)
		relay.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /acme-authorize = %d, want 405", m, rec.Code)
		}
	}

	// Body > 64 KiB gets 413 and forwards nothing.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "https://127.0.0.1:9443/acme-authorize", bytes.NewReader(make([]byte, maxBodyBytes+1)))
	relay.ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("64KiB+1 body = %d, want 413", rec.Code)
	}
	if calls != 0 {
		t.Fatalf("upstream received %d calls from rejected requests", calls)
	}

	// Exactly 64 KiB succeeds.
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "https://127.0.0.1:9443/acme-authorize", bytes.NewReader(make([]byte, maxBodyBytes)))
	relay.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || calls != 1 {
		t.Fatalf("64KiB body = %d (calls=%d), want 200 and 1 call", rec.Code, calls)
	}
}

func TestRelayVerifiesUpstreamTLSAgainstCA(t *testing.T) {
	upstreamPKI := makeLoopbackPKI(t, "upstream")
	wrongPKI := makeLoopbackPKI(t, "wrong-ca")
	upstream := newHTTPSUpstream(t, upstreamPKI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	caPath := filepath.Join(t.TempDir(), "wrong.pem")
	_ = os.WriteFile(caPath, wrongPKI.caPEM, 0o600)
	client, err := newUpstreamClient(caPath, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	logs := &lockedLog{}
	relay := &hookRelay{
		upstreamBase: upstream.URL,
		token:        func() string { return "secret-never-log" },
		client:       client,
		log:          slog.New(slog.NewTextHandler(logs, nil)),
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "https://127.0.0.1:9443/scep-authorize", strings.NewReader(`{"body":"secret-body"}`))
	req.Header.Set(headerSmallstepSig, "secret-sig")
	relay.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("wrong upstream CA = %d, want 502", rec.Code)
	}
	for _, s := range []string{"secret-never-log", "secret-body", "secret-sig"} {
		if strings.Contains(logs.String(), s) {
			t.Fatalf("error log leaked %q:\n%s", s, logs.String())
		}
	}
}

func TestRelayConfigValidation(t *testing.T) {
	valid := func() relayConfig {
		return relayConfig{
			Listen:          "127.0.0.1:9443",
			CertFile:        "/etc/cahookrelay/tls/tls.crt",
			KeyFile:         "/etc/cahookrelay/tls/tls.key",
			UpstreamURL:     "https://i10-api-ca-hooks.i10-prod.svc:3443",
			UpstreamCAFile:  "/etc/cahookrelay/ca/ca.crt",
			TokenFile:       "/etc/cahookrelay/token/token",
			UpstreamTimeout: 10 * time.Second,
		}
	}
	if err := valid().validate(); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
	for name, mutate := range map[string]func(*relayConfig){
		"wildcard listen":     func(c *relayConfig) { c.Listen = "0.0.0.0:9443" },
		"non-loopback listen": func(c *relayConfig) { c.Listen = "10.0.0.5:9443" },
		"http upstream":       func(c *relayConfig) { c.UpstreamURL = "http://i10-api:3443" },
		"upstream with query": func(c *relayConfig) { c.UpstreamURL = "https://i10-api:3443?x=1" },
		"missing CA file":     func(c *relayConfig) { c.UpstreamCAFile = "" },
		"missing token file":  func(c *relayConfig) { c.TokenFile = "" },
		"timeout too short":   func(c *relayConfig) { c.UpstreamTimeout = 100 * time.Millisecond },
		"timeout too long":    func(c *relayConfig) { c.UpstreamTimeout = time.Minute },
	} {
		c := valid()
		mutate(&c)
		if err := c.validate(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
