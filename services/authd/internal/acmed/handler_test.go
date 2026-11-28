package acmed

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/i10-tech/i10/services/authd/internal/appleattest"
	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis/redistest"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

type localEnrollctlFinalizer struct {
	handler *enrollctl.Handler
	token   string
}

func (l *localEnrollctlFinalizer) Finalize(_ context.Context, req FinalizeRequest) (FinalizeResponse, error) {
	raw, _ := json.Marshal(req)
	httpReq := httptest.NewRequest(http.MethodPost, "/acme/finalize", bytes.NewReader(raw))
	httpReq.Header.Set("Authorization", "Bearer "+l.token)
	httpReq.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	l.handler.ServeHTTP(rec, httpReq)
	if rec.Code >= 500 {
		return FinalizeResponse{}, ErrUpstreamUnavailable
	}
	var resp FinalizeResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	return resp, nil
}

type fakeBindBatcher struct {
	devices map[string]string // deviceID -> serial
}

func (f *fakeBindBatcher) Mint(context.Context, enrollctl.MintRequest) enrollctl.MintResult {
	return enrollctl.MintResult{OK: true}
}

func (f *fakeBindBatcher) BindMac(_ context.Context, req enrollctl.BindMacRequest) enrollctl.BindMacResult {
	ser, ok := f.devices[req.DeviceID]
	if !ok {
		return enrollctl.BindMacResult{OK: false, RefusalCode: "device_not_found"}
	}
	if ser != req.Serial {
		return enrollctl.BindMacResult{OK: false, RefusalCode: "serial_mismatch"}
	}
	return enrollctl.BindMacResult{OK: true}
}

// spyStore is the real Redis store, recording the nonces acmed's scripts
// spend. With orderReads set, each GetACMEOrder reads and then waits until
// orderReads.n reads have arrived, so a burst all reads the same state before
// any of it writes.
type spyStore struct {
	enrollredis.Store
	mu         sync.Mutex
	spent      []string
	orderReads *readBarrier
}

// readBarrier releases its waiters once n have arrived (or after 2 s).
type readBarrier struct {
	mu      sync.Mutex
	n       int
	arrived int
	all     chan struct{}
}

func newReadBarrier(n int) *readBarrier { return &readBarrier{n: n, all: make(chan struct{})} }

func (b *readBarrier) wait() {
	b.mu.Lock()
	b.arrived++
	if b.arrived == b.n {
		close(b.all)
	}
	b.mu.Unlock()
	select {
	case <-b.all:
	case <-time.After(2 * time.Second):
	}
}

func (s *spyStore) GetACMEOrder(ctx context.Context, id string) (*enrollredis.ACMEOrder, error) {
	o, err := s.Store.GetACMEOrder(ctx, id)
	s.mu.Lock()
	b := s.orderReads
	s.mu.Unlock()
	if b != nil {
		b.wait()
	}
	return o, err
}

func (s *spyStore) record(nonce string, ok bool) {
	if ok && nonce != "" {
		s.mu.Lock()
		s.spent = append(s.spent, nonce)
		s.mu.Unlock()
	}
}

func (s *spyStore) spentCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.spent)
}

func (s *spyStore) CreateACMEOrder(ctx context.Context, o enrollredis.ACMEOrder, a enrollredis.ACMEAuthz, nonce string, ttl time.Duration, max int, now time.Time) (string, error) {
	st, err := s.Store.CreateACMEOrder(ctx, o, a, nonce, ttl, max, now)
	s.record(nonce, err == nil && st == "OK")
	return st, err
}

func (s *spyStore) MoveACMEOrder(ctx context.Context, m enrollredis.ACMEOrderMove) (enrollredis.ACMEResult, error) {
	res, err := s.Store.MoveACMEOrder(ctx, m)
	s.record(m.Nonce, err == nil && res.Outcome == enrollredis.ACMEOK)
	return res, err
}

func (s *spyStore) AnswerACMEChallenge(ctx context.Context, a enrollredis.ACMEChallengeAnswer) (enrollredis.ACMEResult, error) {
	res, err := s.Store.AnswerACMEChallenge(ctx, a)
	s.record(a.Nonce, err == nil && res.Outcome == enrollredis.ACMEOK)
	return res, err
}

// countingFinalizer counts enrollctl calls, can hold them, and with fail set
// answers upstream unavailable.
type countingFinalizer struct {
	Finalizer
	mu        sync.Mutex
	calls     int
	delay     time.Duration // every call waits this long first
	gateFirst chan struct{} // the first call signals entered, then waits for it to close
	entered   chan struct{}
	fail      bool
}

func (c *countingFinalizer) Finalize(ctx context.Context, req FinalizeRequest) (FinalizeResponse, error) {
	c.mu.Lock()
	c.calls++
	first, delay, fail := c.calls == 1, c.delay, c.fail
	gate, entered := c.gateFirst, c.entered
	c.mu.Unlock()
	if first && gate != nil {
		entered <- struct{}{}
		<-gate
	}
	time.Sleep(delay)
	if fail {
		return FinalizeResponse{}, ErrUpstreamUnavailable
	}
	return c.Finalizer.Finalize(ctx, req)
}

func (c *countingFinalizer) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// put writes an ACME object straight to Redis (a state no handler path
// leaves, or one a test needs to shape), living ttl.
func (w *testACMEWorld) put(key string, v any, ttl time.Duration) {
	w.t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		w.t.Fatal(err)
	}
	if err := w.redis.Set(context.Background(), key, raw, ttl).Err(); err != nil {
		w.t.Fatal(err)
	}
}

type testACMEWorld struct {
	t           *testing.T
	now         time.Time
	store       *enrollredis.RedisStore
	spy         *spyStore
	finalizer   *countingFinalizer
	redis       *redis.Client
	nonceRing   *enrolltoken.Ring
	pathRing    *enrolltoken.Ring
	nonceDev    *macDevice // any valid token serves new-nonce
	handler     *Handler
	acmeRing    *enrolltoken.Ring
	appleInter  *x509.Certificate
	appleKey    *ecdsa.PrivateKey
	fakeInter   *x509.Certificate
	fakeKey     *ecdsa.PrivateKey
	bindBatcher *fakeBindBatcher
}

func newTestACMEWorld(t *testing.T) *testACMEWorld {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)

	makeCA := func(cn string) (*x509.Certificate, *x509.Certificate, *ecdsa.PrivateKey) {
		rk, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
		rt := &x509.Certificate{
			SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: cn + " Root"},
			NotBefore: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour),
			KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true, IsCA: true,
		}
		rDER, _ := x509.CreateCertificate(rand.Reader, rt, rt, &rk.PublicKey, rk)
		rCert, _ := x509.ParseCertificate(rDER)
		ik, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
		it := &x509.Certificate{
			SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: cn + " Inter"},
			NotBefore: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour),
			KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true, IsCA: true,
		}
		iDER, _ := x509.CreateCertificate(rand.Reader, it, rCert, &ik.PublicKey, rk)
		iCert, _ := x509.ParseCertificate(iDER)
		return rCert, iCert, ik
	}

	appleRoot, appleInter, appleKey := makeCA("Test Apple Attest")
	_, fakeInter, fakeKey := makeCA("Fake Attacker")
	_, devInter, devInterKey := makeCA("Test Device CA")

	applePool := x509.NewCertPool()
	applePool.AddCert(appleRoot)
	appleVerifier := appleattest.NewVerifierForTest(applePool)

	issuer, err := enrollctl.NewStaticDeviceCAIssuer(devInter, devInterKey)
	if err != nil {
		t.Fatal(err)
	}
	acmeKeyB64 := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x44}, 32))
	acmeRing, _ := enrolltoken.ParseNonEmptyRing("acme", "1:"+acmeKeyB64)
	acmedTok := "acmed-bearer-token-0123456789"
	tokSum := sha256.Sum256([]byte(acmedTok))

	bindBatcher := &fakeBindBatcher{devices: make(map[string]string)}
	ectl := enrollctl.NewHandler(enrollctl.HandlerDeps{
		Batcher:        bindBatcher,
		ACMEPermitKeys: acmeRing,
		DeviceCAIssuer: issuer,
		AppleAttest:    appleVerifier,
		AcmedTokens:    [][]byte{tokSum[:]},
		Now:            func() time.Time { return now },
	})

	store, rc := redistest.Open(t)
	nonceRing, _ := enrolltoken.ParseNonEmptyRing("nonce", "7:"+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x55}, 32)))
	pathRing, _ := enrolltoken.ParseNonEmptyRing("path", "8:"+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x77}, 32)))
	w := &testACMEWorld{
		t:           t,
		now:         now,
		store:       store,
		spy:         &spyStore{Store: store},
		redis:       rc,
		nonceRing:   nonceRing,
		pathRing:    pathRing,
		acmeRing:    acmeRing,
		appleInter:  appleInter,
		appleKey:    appleKey,
		fakeInter:   fakeInter,
		fakeKey:     fakeKey,
		bindBatcher: bindBatcher,
	}
	w.finalizer = &countingFinalizer{Finalizer: &localEnrollctlFinalizer{handler: ectl, token: acmedTok}}
	w.handler = NewHandler(HandlerDeps{
		Store:              w.spy,
		Finalizer:          w.finalizer,
		AppleAttest:        appleVerifier,
		NonceKeys:          nonceRing,
		PathKeys:           pathRing,
		BaseURL:            "https://ca.i10.tech",
		Prefix:             "/acme/apple",
		MaxOrdersPerDevice: 5,
		Now:                func() time.Time { return w.now },
	})
	w.nonceDev = w.mac("C02NONCE")
	return w
}

// macDevice is a sealed Mac as acmed sees it: a device id and the base of
// the directory URL its profile carries.
type macDevice struct {
	uuid   [16]byte
	id     string
	serial string
	token  string
	base   string // https://ca.i10.tech/acme/apple/d/<token>
}

func (d *macDevice) url(sub string) string { return d.base + sub }

// mac seals a Mac: a fresh device id for serial, known to the fake batcher,
// with the path token enrollctl would put in its profile.
func (w *testACMEWorld) mac(serial string) *macDevice {
	w.t.Helper()
	dev, _ := enrolltoken.NewUUIDv7At(w.now)
	tok, err := enrolltoken.SignACMEPath(w.pathRing, dev, serial, w.now.Add(enrolltoken.ACMEPathLifetime))
	if err != nil {
		w.t.Fatal(err)
	}
	d := &macDevice{uuid: dev, id: enrolltoken.FormatUUID(dev), serial: serial, token: tok,
		base: "https://ca.i10.tech/acme/apple/d/" + tok}
	w.bindBatcher.devices[d.id] = serial
	return d
}

func (w *testACMEWorld) getNonce() string {
	req := httptest.NewRequest(http.MethodHead, strings.TrimPrefix(w.nonceDev.url("/new-nonce"), "https://ca.i10.tech"), nil)
	rec := httptest.NewRecorder()
	w.handler.ServeHTTP(rec, req)
	if rec.Code != 200 {
		w.t.Fatalf("HEAD new-nonce = %d", rec.Code)
	}
	n := rec.Header().Get("Replay-Nonce")
	if n == "" {
		w.t.Fatal("missing Replay-Nonce")
	}
	return n
}

// postJWS posts to an acmed URL (https://ca.i10.tech/...).
func (w *testACMEWorld) postJWS(url string, body []byte, hostHeader string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, strings.TrimPrefix(url, "https://ca.i10.tech"), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/jose+json")
	if hostHeader != "" {
		req.Host = hostHeader
	}
	rec := httptest.NewRecorder()
	w.handler.ServeHTTP(rec, req)
	return rec
}

// registerAccount answers the account URL for acctKey under d's token.
func (w *testACMEWorld) registerAccount(d *macDevice, acctKey *ecdsa.PrivateKey) string {
	jwk, err := EncodePublicECJWK(&acctKey.PublicKey)
	if err != nil {
		w.t.Fatal(err)
	}
	jws, err := SignFlattenedJWS(acctKey, ProtectedHeader{
		Nonce: w.getNonce(),
		URL:   d.url("/new-account"),
		JWK:   jwk,
	}, []byte(`{"termsOfServiceAgreed":true}`))
	if err != nil {
		w.t.Fatal(err)
	}
	rec := w.postJWS(d.url("/new-account"), jws, "")
	if rec.Code != 201 {
		w.t.Fatalf("new-account = %d: %s", rec.Code, rec.Body.String())
	}
	return rec.Header().Get("Location")
}

func (w *testACMEWorld) makeAttestCert(inter *x509.Certificate, interKey *ecdsa.PrivateKey, serial string, nonce []byte) ([]byte, *ecdsa.PrivateKey) {
	leafKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	var exts []pkix.Extension
	if serial != "" {
		exts = append(exts, pkix.Extension{Id: appleattest.OIDAppleSerialNumber, Value: []byte(serial)})
	}
	if nonce != nil {
		exts = append(exts, pkix.Extension{Id: appleattest.OIDAppleNonce, Value: nonce})
	}
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(500), Subject: pkix.Name{CommonName: "Apple Attest"},
		NotBefore: w.now.Add(-time.Minute), NotAfter: w.now.Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtraExtensions: exts,
	}, inter, &leafKey.PublicKey, interKey)
	if err != nil {
		w.t.Fatal(err)
	}
	return der, leafKey
}

func TestACMEHappyPathEndToEnd(t *testing.T) {
	w := newTestACMEWorld(t)

	// 1. A sealed Mac with its path token and OU permit.
	const serial = "C02ACMEOK001"
	d := w.mac(serial)
	ouPermit, _ := enrolltoken.SignACMEPermit(w.acmeRing, d.uuid, w.now.Add(10*time.Minute))

	// 2. Directory + GET new-nonce, both under the token.
	dirRec := httptest.NewRecorder()
	w.handler.ServeHTTP(dirRec, httptest.NewRequest(http.MethodGet, strings.TrimPrefix(d.url("/directory"), "https://ca.i10.tech"), nil))
	if dirRec.Code != 200 || !strings.Contains(dirRec.Body.String(), d.url("/new-order")) {
		t.Fatalf("directory = (%d, %s)", dirRec.Code, dirRec.Body.String())
	}
	nnRec := httptest.NewRecorder()
	w.handler.ServeHTTP(nnRec, httptest.NewRequest(http.MethodGet, strings.TrimPrefix(d.url("/new-nonce"), "https://ca.i10.tech"), nil))
	if nnRec.Code != 204 || nnRec.Header().Get("Replay-Nonce") == "" {
		t.Fatalf("GET new-nonce = (%d, nonce=%q)", nnRec.Code, nnRec.Header().Get("Replay-Nonce"))
	}

	// 3. Account registration + POST-as-GET account.
	acctKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid := w.registerAccount(d, acctKey)
	getAcctJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: kid, KID: kid}, nil)
	if rec := w.postJWS(kid, getAcctJWS, ""); rec.Code != 200 {
		t.Fatalf("POST-as-GET account = %d: %s", rec.Code, rec.Body.String())
	}

	// 4. New order.
	ordPayload := []byte(`{"identifiers":[{"type":"permanent-identifier","value":"` + serial + `"}]}`)
	ordJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-order"), KID: kid}, ordPayload)
	ordRec := w.postJWS(d.url("/new-order"), ordJWS, "")
	if ordRec.Code != 201 {
		t.Fatalf("new-order = %d: %s", ordRec.Code, ordRec.Body.String())
	}
	orderURL := ordRec.Header().Get("Location")
	var ordBody struct {
		Status         string   `json:"status"`
		Authorizations []string `json:"authorizations"`
		Finalize       string   `json:"finalize"`
	}
	_ = json.Unmarshal(ordRec.Body.Bytes(), &ordBody)
	if ordBody.Status != "pending" || len(ordBody.Authorizations) != 1 {
		t.Fatalf("order = %+v", ordBody)
	}

	// 5. Fetch authz.
	authzURL := ordBody.Authorizations[0]
	authzJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: authzURL, KID: kid}, nil)
	authzRec := w.postJWS(authzURL, authzJWS, "")
	if authzRec.Code != 200 {
		t.Fatalf("authz = %d: %s", authzRec.Code, authzRec.Body.String())
	}
	var authzBody struct {
		Challenges []struct {
			Type  string `json:"type"`
			Token string `json:"token"`
			URL   string `json:"url"`
		} `json:"challenges"`
	}
	_ = json.Unmarshal(authzRec.Body.Bytes(), &authzBody)
	chal := authzBody.Challenges[0]
	if chal.Type != "device-attest-01" || chal.Token == "" {
		t.Fatalf("unexpected challenge: %+v", chal)
	}

	// 6. Respond to device-attest-01 challenge with Apple CBOR attObj.
	chalNonce := sha256.Sum256([]byte(chal.Token))
	attLeaf, attKey := w.makeAttestCert(w.appleInter, w.appleKey, serial, chalNonce[:])
	cborAtt := EncodeAppleAttestationCBOR([][]byte{attLeaf, w.appleInter.Raw})
	chalPay, _ := json.Marshal(map[string]string{"attObj": base64.RawURLEncoding.EncodeToString(cborAtt)})
	chalJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: chal.URL, KID: kid}, chalPay)
	chalRec := w.postJWS(chal.URL, chalJWS, "")
	if chalRec.Code != 200 || !strings.Contains(chalRec.Body.String(), `"status":"valid"`) {
		t.Fatalf("challenge = (%d, %s)", chalRec.Code, chalRec.Body.String())
	}
	if !strings.Contains(strings.Join(chalRec.Header().Values("Link"), ","), `rel="up"`) {
		t.Fatalf("challenge missing rel=up Link header: %v", chalRec.Header()["Link"])
	}

	// 7. Finalize order with CSR signed by attested key.
	csrDER, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: serial, OrganizationalUnit: []string{ouPermit}},
	}, attKey)
	finPay, _ := json.Marshal(map[string]string{"csr": base64.RawURLEncoding.EncodeToString(csrDER)})
	finJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: ordBody.Finalize, KID: kid}, finPay)
	finRec := w.postJWS(ordBody.Finalize, finJWS, "")
	if finRec.Code != 200 {
		t.Fatalf("finalize = (%d, %s)", finRec.Code, finRec.Body.String())
	}
	var finBody struct {
		Status      string `json:"status"`
		Certificate string `json:"certificate"`
	}
	_ = json.Unmarshal(finRec.Body.Bytes(), &finBody)
	if finBody.Status != "valid" || finBody.Certificate == "" {
		t.Fatalf("finalize body = %+v", finBody)
	}

	// 8. Fetch order + certificate PEM chain via POST-as-GET.
	pollOrdJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: orderURL, KID: kid}, nil)
	if rec := w.postJWS(orderURL, pollOrdJWS, ""); rec.Code != 200 {
		t.Fatalf("POST-as-GET order = %d", rec.Code)
	}

	certJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: finBody.Certificate, KID: kid}, nil)
	certRec := w.postJWS(finBody.Certificate, certJWS, "")
	if certRec.Code != 200 || certRec.Header().Get("Content-Type") != "application/pem-certificate-chain" {
		t.Fatalf("certificate = (%d, ct=%q)", certRec.Code, certRec.Header().Get("Content-Type"))
	}
	if strings.Count(certRec.Body.String(), "BEGIN CERTIFICATE") != 2 {
		t.Fatalf("expected leaf + intermediate PEM chain, got:\n%s", certRec.Body.String())
	}
}

func TestACMEMacOSShortECDSASignatureQuirkAccepted(t *testing.T) {
	// Proves we accept macOS ACME client signatures that omit 1 leading 0x00 byte
	// on R or S (matching step-ca acme/api/middleware.go).
	acctKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&acctKey.PublicKey)
	hdr := ProtectedHeader{Alg: "ES256", Nonce: "nonce-1", URL: "https://ca.i10.tech/acme/apple/new-account", JWK: jwk}
	protBytes, _ := json.Marshal(hdr)
	protB64 := base64.RawURLEncoding.EncodeToString(protBytes)
	payB64 := base64.RawURLEncoding.EncodeToString([]byte(`{}`))
	digest := sha256.Sum256([]byte(protB64 + "." + payB64))

	// Generate signatures until we get one whose R starts with 0x00 (< 2^248) so
	// stripping 1 leading zero yields a genuine 63-byte macOS-style signature.
	var shortSig []byte
	for i := 0; i < 4096; i++ {
		r, s, err := ecdsa.Sign(rand.Reader, acctKey, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		rb := r.Bytes()
		sb := s.Bytes()
		if len(rb) == 31 && len(sb) == 32 {
			shortSig = append(rb, sb...)
			break
		}
	}
	if len(shortSig) != 63 {
		t.Skip("did not draw a leading-zero R within 4096 iterations")
	}
	raw, _ := json.Marshal(FlattenedJWS{
		Protected: protB64,
		Payload:   payB64,
		Signature: base64.RawURLEncoding.EncodeToString(shortSig),
	})
	parsed, err := ParseFlattenedJWS(raw, hdr.URL, true)
	if err != nil {
		t.Fatalf("ParseFlattenedJWS: %v", err)
	}
	if err := parsed.VerifySignature(parsed.PubKey); err != nil {
		t.Fatalf("63-byte macOS leading-zero ECDSA signature refused: %v", err)
	}
}

func TestACMEEverySecurityRefusal(t *testing.T) {
	w := newTestACMEWorld(t)
	d0 := w.mac("C02REPLAY")
	acctKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&acctKey.PublicKey)
	kid := w.registerAccount(d0, acctKey)

	expectProblem := func(name string, rec *httptest.ResponseRecorder, wantStatus int, wantType string) {
		t.Helper()
		if rec.Code != wantStatus {
			t.Errorf("%s: status = %d, want %d (body: %s)", name, rec.Code, wantStatus, rec.Body.String())
			return
		}
		var p Problem
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil || p.Type != wantType {
			t.Errorf("%s: problem = %+v, want type %q", name, p, wantType)
		}
	}

	rawJWS := func(prot map[string]any, payload []byte, sig []byte) []byte {
		pb, _ := json.Marshal(prot)
		p64 := base64.RawURLEncoding.EncodeToString(pb)
		pay64 := ""
		if len(payload) > 0 {
			pay64 = base64.RawURLEncoding.EncodeToString(payload)
		}
		b, _ := json.Marshal(FlattenedJWS{
			Protected: p64,
			Payload:   pay64,
			Signature: base64.RawURLEncoding.EncodeToString(sig),
		})
		return b
	}

	// 1. bad alg (HS256, RS256) and alg none
	for _, alg := range []string{"none", "HS256", "RS256"} {
		body := rawJWS(map[string]any{
			"alg": alg, "nonce": w.getNonce(), "url": d0.url("/new-account"), "jwk": jwk,
		}, []byte(`{}`), bytes.Repeat([]byte{1}, 64))
		expectProblem("alg="+alg, w.postJWS(d0.url("/new-account"), body, ""), 400, ProblemBadSignatureAlgorithm)
	}

	// 2. crit and b64=false refused
	bodyCrit := rawJWS(map[string]any{
		"alg": "ES256", "nonce": w.getNonce(), "url": d0.url("/new-account"), "jwk": jwk, "crit": []string{"exp"},
	}, []byte(`{}`), bytes.Repeat([]byte{1}, 64))
	expectProblem("crit", w.postJWS(d0.url("/new-account"), bodyCrit, ""), 400, ProblemMalformed)

	bodyB64 := rawJWS(map[string]any{
		"alg": "ES256", "nonce": w.getNonce(), "url": d0.url("/new-account"), "jwk": jwk, "b64": false,
	}, []byte(`{}`), bytes.Repeat([]byte{1}, 64))
	expectProblem("b64=false", w.postJWS(d0.url("/new-account"), bodyB64, ""), 400, ProblemMalformed)

	// 3. bad signature
	validJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d0.url("/new-order"), KID: kid}, []byte(`{}`))
	var env FlattenedJWS
	_ = json.Unmarshal(validJWS, &env)
	sig, _ := base64.RawURLEncoding.DecodeString(env.Signature)
	sig[0] ^= 0xff
	env.Signature = base64.RawURLEncoding.EncodeToString(sig)
	tamperedSig, _ := json.Marshal(env)
	expectProblem("bad signature", w.postJWS(d0.url("/new-order"), tamperedSig, ""), 400, ProblemMalformed)

	// 4. wrong url (even when Host header matches attacker's URL!)
	wrongURLJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: "https://evil.example/acme/apple/new-order", KID: kid}, []byte(`{}`))
	expectProblem("wrong url with matching Host", w.postJWS(d0.url("/new-order"), wrongURLJWS, "evil.example"), 400, ProblemUnauthorized)

	// 5. reused nonce, on a request allowed to touch state (a new order for a
	// sealed serial): the replay is badNonce.
	nJWS1, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d0.url("/new-order"), KID: kid},
		[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"C02REPLAY"}]}`))
	if rec := w.postJWS(d0.url("/new-order"), nJWS1, ""); rec.Code != 201 {
		t.Fatalf("first use of nonce = %d: %s", rec.Code, rec.Body.String())
	}
	expectProblem("reused nonce", w.postJWS(d0.url("/new-order"), nJWS1, ""), 400, ProblemBadNonce)

	// 6. expired nonce (a nonce lives 5 minutes)
	expNonce := w.getNonce()
	w.now = w.now.Add(nonceLifetime + time.Second)
	expJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: expNonce, URL: kid, KID: kid}, nil)
	expectProblem("expired nonce", w.postJWS(kid, expJWS, ""), 400, ProblemBadNonce)

	// 7. jwk + kid both present
	bothBody := rawJWS(map[string]any{
		"alg": "ES256", "nonce": w.getNonce(), "url": d0.url("/new-account"), "jwk": jwk, "kid": kid,
	}, []byte(`{}`), bytes.Repeat([]byte{1}, 64))
	expectProblem("jwk+kid both", w.postJWS(d0.url("/new-account"), bothBody, ""), 400, ProblemMalformed)

	// 8. kid on newAccount
	kidOnNewAcct, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d0.url("/new-account"), KID: kid}, []byte(`{}`))
	expectProblem("kid on newAccount", w.postJWS(d0.url("/new-account"), kidOnNewAcct, ""), 400, ProblemMalformed)

	// 9. unknown account
	unknownKID := d0.url("/account/unknownaccountid123")
	unkJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d0.url("/new-order"), KID: unknownKID}, []byte(`{}`))
	expectProblem("unknown account", w.postJWS(d0.url("/new-order"), unkJWS, ""), 400, ProblemAccountDoesNotExist)

	// 10. order for a serial the path token does not cover -> 403 rejectedIdentifier
	unsealedJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d0.url("/new-order"), KID: kid},
		[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"C02UNSEALED"}]}`))
	expectProblem("unsealed serial", w.postJWS(d0.url("/new-order"), unsealedJWS, ""), 403, ProblemRejectedIdentifier)

	// Helper to open an order for a sealed Mac serial.
	openOrder := func(serial string) (kid string, orderURL, finalizeURL, chalURL, chalToken string) {
		d := w.mac(serial)
		kid = w.registerAccount(d, acctKey)
		oJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-order"), KID: kid},
			[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"`+serial+`"}]}`))
		oRec := w.postJWS(d.url("/new-order"), oJWS, "")
		if oRec.Code != 201 {
			t.Fatalf("openOrder %s = %d: %s", serial, oRec.Code, oRec.Body.String())
		}
		orderURL = oRec.Header().Get("Location")
		var ob struct {
			Authorizations []string `json:"authorizations"`
			Finalize       string   `json:"finalize"`
		}
		_ = json.Unmarshal(oRec.Body.Bytes(), &ob)
		finalizeURL = ob.Finalize
		aURL := ob.Authorizations[0]
		aJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: aURL, KID: kid}, nil)
		aRec := w.postJWS(aURL, aJWS, "")
		var ab struct {
			Challenges []struct {
				Token string `json:"token"`
				URL   string `json:"url"`
			} `json:"challenges"`
		}
		_ = json.Unmarshal(aRec.Body.Bytes(), &ab)
		return kid, orderURL, finalizeURL, ab.Challenges[0].URL, ab.Challenges[0].Token
	}

	// 11. attestation chain to fake root -> badAttestationStatement
	kid1, _, _, chalURL1, tok1 := openOrder("C02REFUSE1")
	n1 := sha256.Sum256([]byte(tok1))
	fakeLeaf, _ := w.makeAttestCert(w.fakeInter, w.fakeKey, "C02REFUSE1", n1[:])
	cPay1, _ := json.Marshal(map[string]string{"attObj": base64.RawURLEncoding.EncodeToString(EncodeAppleAttestationCBOR([][]byte{fakeLeaf, w.fakeInter.Raw}))})
	cJWS1, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: chalURL1, KID: kid1}, cPay1)
	expectProblem("fake root", w.postJWS(chalURL1, cJWS1, ""), 400, ProblemBadAttestationStatement)

	// 12. nonce mismatch -> badAttestationStatement
	kid2c, _, _, chalURL2, _ := openOrder("C02REFUSE2")
	wrongNonce := sha256.Sum256([]byte("wrong-token"))
	badNonceLeaf, _ := w.makeAttestCert(w.appleInter, w.appleKey, "C02REFUSE2", wrongNonce[:])
	cPay2, _ := json.Marshal(map[string]string{"attObj": base64.RawURLEncoding.EncodeToString(EncodeAppleAttestationCBOR([][]byte{badNonceLeaf, w.appleInter.Raw}))})
	cJWS2, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: chalURL2, KID: kid2c}, cPay2)
	expectProblem("nonce mismatch", w.postJWS(chalURL2, cJWS2, ""), 400, ProblemBadAttestationStatement)

	// 13. serial mismatch -> badAttestationStatement
	kid3, _, _, chalURL3, tok3 := openOrder("C02REFUSE3")
	n3 := sha256.Sum256([]byte(tok3))
	wrongSerLeaf, _ := w.makeAttestCert(w.appleInter, w.appleKey, "C02OTHER", n3[:])
	cPay3, _ := json.Marshal(map[string]string{"attObj": base64.RawURLEncoding.EncodeToString(EncodeAppleAttestationCBOR([][]byte{wrongSerLeaf, w.appleInter.Raw}))})
	cJWS3, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: chalURL3, KID: kid3}, cPay3)
	expectProblem("serial mismatch", w.postJWS(chalURL3, cJWS3, ""), 400, ProblemBadAttestationStatement)

	// 14. Valid challenge, then test every finalize refusal (CSR key mismatch, CN mismatch, two OUs, forged permit, expired permit, permit for another device).
	// Use fresh account so order cap (5) doesn't trigger yet.
	acctKey2, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kids := map[string]string{} // finalize URL -> the account URL under its device's token
	openReadyOrder := func(serial string) (devUUID [16]byte, finURL string, attKey *ecdsa.PrivateKey) {
		d := w.mac(serial)
		devUUID = d.uuid
		kid2 := w.registerAccount(d, acctKey2)
		oJWS, _ := SignFlattenedJWS(acctKey2, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-order"), KID: kid2},
			[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"`+serial+`"}]}`))
		oRec := w.postJWS(d.url("/new-order"), oJWS, "")
		var ob struct {
			Authorizations []string `json:"authorizations"`
			Finalize       string   `json:"finalize"`
		}
		_ = json.Unmarshal(oRec.Body.Bytes(), &ob)
		aJWS, _ := SignFlattenedJWS(acctKey2, ProtectedHeader{Nonce: w.getNonce(), URL: ob.Authorizations[0], KID: kid2}, nil)
		aRec := w.postJWS(ob.Authorizations[0], aJWS, "")
		var ab struct {
			Challenges []struct {
				Token string `json:"token"`
				URL   string `json:"url"`
			} `json:"challenges"`
		}
		_ = json.Unmarshal(aRec.Body.Bytes(), &ab)
		nn := sha256.Sum256([]byte(ab.Challenges[0].Token))
		leaf, key := w.makeAttestCert(w.appleInter, w.appleKey, serial, nn[:])
		cp, _ := json.Marshal(map[string]string{"attObj": base64.RawURLEncoding.EncodeToString(EncodeAppleAttestationCBOR([][]byte{leaf, w.appleInter.Raw}))})
		cj, _ := SignFlattenedJWS(acctKey2, ProtectedHeader{Nonce: w.getNonce(), URL: ab.Challenges[0].URL, KID: kid2}, cp)
		cRec := w.postJWS(ab.Challenges[0].URL, cj, "")
		if cRec.Code != 200 {
			t.Fatalf("openReadyOrder challenge = %d: %s", cRec.Code, cRec.Body.String())
		}
		kids[ob.Finalize] = kid2
		return devUUID, ob.Finalize, key
	}

	postFinalize := func(finURL string, csrDER []byte) *httptest.ResponseRecorder {
		fp, _ := json.Marshal(map[string]string{"csr": base64.RawURLEncoding.EncodeToString(csrDER)})
		fj, _ := SignFlattenedJWS(acctKey2, ProtectedHeader{Nonce: w.getNonce(), URL: finURL, KID: kids[finURL]}, fp)
		return w.postJWS(finURL, fj, "")
	}

	dev1, fin1, attKey1 := openReadyOrder("C02FIN1")
	validPermit1, _ := enrolltoken.SignACMEPermit(w.acmeRing, dev1, w.now.Add(10*time.Minute))

	// CSR key mismatch -> 400 badCSR (order stays ready for next check!)
	wrongKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	csrWrongKey, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "C02FIN1", OrganizationalUnit: []string{validPermit1}},
	}, wrongKey)
	expectProblem("csr key mismatch", postFinalize(fin1, csrWrongKey), 400, ProblemBadCSR)

	// CN mismatch -> 400 badCSR
	csrWrongCN, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "C02WRONG", OrganizationalUnit: []string{validPermit1}},
	}, attKey1)
	expectProblem("cn mismatch", postFinalize(fin1, csrWrongCN), 400, ProblemBadCSR)

	// Two OUs -> 400 badCSR
	csrTwoOUs, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "C02FIN1", OrganizationalUnit: []string{validPermit1, "second"}},
	}, attKey1)
	expectProblem("two OUs", postFinalize(fin1, csrTwoOUs), 400, ProblemBadCSR)

	// Forged permit -> enrollctl refuses -> 403 unauthorized
	csrForged, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "C02FIN1", OrganizationalUnit: []string{strings.Repeat("A", 50)}},
	}, attKey1)
	expectProblem("forged permit", postFinalize(fin1, csrForged), 403, ProblemUnauthorized)

	// Expired permit -> enrollctl refuses -> 403 unauthorized
	dev2, fin2, attKey2 := openReadyOrder("C02FIN2")
	expPermit, _ := enrolltoken.SignACMEPermit(w.acmeRing, dev2, w.now.Add(-time.Minute))
	csrExpPermit, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "C02FIN2", OrganizationalUnit: []string{expPermit}},
	}, attKey2)
	expectProblem("expired permit", postFinalize(fin2, csrExpPermit), 403, ProblemUnauthorized)

	// Permit for another device -> enrollctl refuses (serial_mismatch) -> 403 unauthorized
	_, fin3, attKey3 := openReadyOrder("C02FIN3")
	otherPermit, _ := enrolltoken.SignACMEPermit(w.acmeRing, dev1, w.now.Add(10*time.Minute)) // dev1 belongs to C02FIN1!
	csrOtherDev, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: "C02FIN3", OrganizationalUnit: []string{otherPermit}},
	}, attKey3)
	expectProblem("permit for another device", postFinalize(fin3, csrOtherDev), 403, ProblemUnauthorized)
}
