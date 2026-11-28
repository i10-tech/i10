package enroll

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type loopbackHTTPS struct {
	server *httptest.Server
	caFile string
}

func newLoopbackHTTPS(t *testing.T, handler http.Handler) *loopbackHTTPS {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	caTpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Test Hooks CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTpl, caTpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}

	srvKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	srvTpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{"localhost"},
	}
	srvDER, err := x509.CreateCertificate(rand.Reader, srvTpl, caCert, &srvKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(srvKey)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(
		pemCert(srvDER),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}

	caPath := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(caPath, pemCert(caDER), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewUnstartedServer(handler)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	srv.StartTLS()
	t.Cleanup(srv.Close)

	return &loopbackHTTPS{server: srv, caFile: caPath}
}

func TestAPIClientContractShapes(t *testing.T) {
	const secretTok = "super-secret-api-bearer-token"

	var gotPath, gotAuth, gotCT string
	var gotBody []byte
	var replyStatus int
	var replyBody string

	apiSrv := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		gotBody, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(replyStatus)
		_, _ = w.Write([]byte(replyBody))
	}))

	client, err := NewAPIClient(apiSrv.server.URL, apiSrv.caFile, secretTok, 5*time.Second)
	if err != nil {
		t.Fatalf("NewAPIClient: %v", err)
	}

	// 1. peek with signed Phase 1 profile
	p1Bytes := []byte("SIGNED-PHASE-1-DER")
	replyStatus = http.StatusOK
	replyBody = `{"live":true,"profile":"` + base64.StdEncoding.EncodeToString(p1Bytes) + `"}`
	peekResp, err := client.Peek(context.Background(), "v1.tok")
	if err != nil || !peekResp.Live || string(peekResp.ProfileBytes) != string(p1Bytes) {
		t.Fatalf("Peek = (%+v, %v), want live with %q", peekResp, err, p1Bytes)
	}
	if gotPath != "/enrolld/peek" || gotAuth != "Bearer "+secretTok || gotCT != "application/json" {
		t.Fatalf("peek request headers/path mismatch: %q %q %q", gotPath, gotAuth, gotCT)
	}
	if string(gotBody) != `{"token":"v1.tok"}` {
		t.Fatalf("peek body = %s", gotBody)
	}

	// 2. attest with null optional fields and signed SCEP profile
	p2Bytes := []byte("SIGNED-PHASE-2-SCEP-DER")
	replyStatus = http.StatusOK
	replyBody = `{"outcome":"scep","profile":"` + base64.StdEncoding.EncodeToString(p2Bytes) + `"}`
	attResp, err := client.Attest(context.Background(), AttestRequest{
		Token:             "v1.tok",
		UDID:              "U1",
		Serial:            "SER1",
		Product:           "iPhone17,2",
		Version:           "22A3354",
		DeviceName:        nil,
		Model:             nil,
		AppleSignerSHA256: strings.Repeat("a", 64),
	})
	if err != nil {
		t.Fatalf("Attest: %v", err)
	}
	if attResp.Outcome != "scep" || string(attResp.ProfileBytes) != string(p2Bytes) {
		t.Fatalf("Attest response = %+v", attResp)
	}
	var rawMap map[string]any
	if err := json.Unmarshal(gotBody, &rawMap); err != nil {
		t.Fatal(err)
	}
	if v, exists := rawMap["deviceName"]; !exists || v != nil {
		t.Fatalf("expected deviceName: null in JSON, got %s", gotBody)
	}
	if v, exists := rawMap["model"]; !exists || v != nil {
		t.Fatalf("expected model: null in JSON, got %s", gotBody)
	}

	// 3. finish with signed sealed profile
	finalBytes := []byte("SIGNED-SEALED-PROFILE-DER")
	replyStatus = http.StatusOK
	replyBody = `{"outcome":"sealed","profile":"` + base64.StdEncoding.EncodeToString(finalBytes) + `"}`
	finResp, err := client.Finish(context.Background(), FinishRequest{
		CertDER: base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
		UDID:    nil,
	})
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if finResp.Outcome != "sealed" || string(finResp.ProfileBytes) != string(finalBytes) {
		t.Fatalf("Finish response mismatch: %+v", finResp)
	}
	if !strings.Contains(string(gotBody), `"udid":null`) {
		t.Fatalf("expected udid:null in finish JSON, got %s", gotBody)
	}
}

func TestAPIClientHardeningAndErrors(t *testing.T) {
	const secretTok = "never-appear-in-error-token"

	t.Run("rejects wrong CA", func(t *testing.T) {
		srv := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"live":false}`))
		}))
		other := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
		client, err := NewAPIClient(srv.server.URL, other.caFile, secretTok, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_, err = client.Peek(context.Background(), "tok")
		if err == nil {
			t.Fatal("expected TLS failure with wrong CA")
		}
		if strings.Contains(err.Error(), secretTok) {
			t.Fatalf("error leaked bearer token: %v", err)
		}
	})

	t.Run("refuses redirects", func(t *testing.T) {
		srv := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://example.invalid/steal", http.StatusFound)
		}))
		client, err := NewAPIClient(srv.server.URL, srv.caFile, secretTok, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.Peek(context.Background(), "tok"); err == nil {
			t.Fatal("redirect succeeded")
		}
	})

	t.Run("caps oversized responses", func(t *testing.T) {
		srv := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"outcome":"sealed","profile":"` + strings.Repeat("A", maxAPIProfileRespBytes+16) + `"}`))
		}))
		client, err := NewAPIClient(srv.server.URL, srv.caFile, secretTok, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := client.Finish(context.Background(), FinishRequest{CertDER: "AA=="}); err == nil {
			t.Fatal("oversized finish response accepted")
		}
	})

	t.Run("rejects 404, 500, missing fields, bad outcomes", func(t *testing.T) {
		var status int
		var body string
		srv := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(body))
		}))
		client, err := NewAPIClient(srv.server.URL, srv.caFile, secretTok, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}

		status, body = http.StatusNotFound, ""
		if _, err := client.Peek(context.Background(), "t"); err == nil {
			t.Error("404 peek succeeded")
		}
		status, body = http.StatusInternalServerError, `{"error":"boom"}`
		if _, err := client.Peek(context.Background(), "t"); err == nil {
			t.Error("500 peek succeeded")
		}
		status, body = http.StatusOK, `{}`
		if _, err := client.Peek(context.Background(), "t"); err == nil {
			t.Error("peek missing live field succeeded")
		}
		status, body = http.StatusOK, `{"live":true}`
		if _, err := client.Peek(context.Background(), "t"); err == nil {
			t.Error("peek live missing profile succeeded")
		}
		status, body = http.StatusOK, `{"live":false}{"extra":1}`
		if _, err := client.Peek(context.Background(), "t"); err == nil {
			t.Error("peek trailing JSON succeeded")
		}
		status, body = http.StatusOK, `{"outcome":"scep"}`
		if _, err := client.Attest(context.Background(), AttestRequest{}); err == nil {
			t.Error("attest missing profile succeeded")
		}
		status, body = http.StatusOK, `{"outcome":"scep","profile":"!!!bad!!!"}`
		if _, err := client.Attest(context.Background(), AttestRequest{}); err == nil {
			t.Error("attest invalid base64 succeeded")
		}
		status, body = http.StatusOK, `{"outcome":"unknown"}`
		if _, err := client.Attest(context.Background(), AttestRequest{}); err == nil {
			t.Error("attest unknown outcome succeeded")
		}
		status, body = http.StatusOK, `{"outcome":"sealed","profile":"!!!bad-b64!!!"}`
		if _, err := client.Finish(context.Background(), FinishRequest{}); err == nil {
			t.Error("finish invalid base64 succeeded")
		}
	})

	t.Run("timeout", func(t *testing.T) {
		block := make(chan struct{})
		srv := newLoopbackHTTPS(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case <-block:
			case <-r.Context().Done():
			}
		}))
		defer close(block)
		client, err := NewAPIClient(srv.server.URL, srv.caFile, secretTok, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
		defer cancel()
		if _, err := client.Peek(ctx, "tok"); err == nil {
			t.Fatal("timed-out call succeeded")
		}
	})
}
