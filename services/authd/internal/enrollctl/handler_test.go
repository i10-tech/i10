package enrollctl

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/appleattest"
	"github.com/i10-tech/i10/services/authd/internal/enroll"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis/redistest"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
	"github.com/i10-tech/i10/services/authd/internal/keyring"
	"github.com/redis/go-redis/v9"
	"github.com/smallstep/pkcs7"
)

const (
	enrolldToken = "enrolld-secret-token-12345678"
	acmedToken   = "acmed-secret-token-87654321"
)

type fakeBatcher struct {
	mu          sync.Mutex
	mintCalls   int
	bindCalls   int
	mintHandler func(req MintRequest) MintResult
	bindHandler func(req BindMacRequest) BindMacResult
}

func (f *fakeBatcher) Mint(_ context.Context, req MintRequest) MintResult {
	f.mu.Lock()
	f.mintCalls++
	fn := f.mintHandler
	f.mu.Unlock()
	if fn != nil {
		return fn(req)
	}
	return MintResult{OK: true}
}

func (f *fakeBatcher) BindMac(_ context.Context, req BindMacRequest) BindMacResult {
	f.mu.Lock()
	f.bindCalls++
	fn := f.bindHandler
	f.mu.Unlock()
	if fn != nil {
		return fn(req)
	}
	return BindMacResult{OK: true}
}

func (f *fakeBatcher) mints() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.mintCalls
}

func sha256Bytes(s string) []byte {
	sum := sha256.Sum256([]byte(s))
	return sum[:]
}

// handlerEnv is one enrollctl Handler with test keys, a test device CA, a test
// "Apple" attestation CA and (when a test asks for it) the test Redis.
type handlerEnv struct {
	h              *Handler
	store          *enrollredis.RedisStore
	redis          *redis.Client
	batch          *fakeBatcher
	signer         *ProfileSignerLoader
	edgeRing       *enrolltoken.Ring
	acmeRing       *enrolltoken.Ring
	pathRing       *enrolltoken.Ring
	deviceInter    *x509.Certificate
	deviceInterKey *ecdsa.PrivateKey
	appleInter     *x509.Certificate
	appleInterKey  *ecdsa.PrivateKey
	logBuf         *bytes.Buffer
	now            time.Time
	clock          *time.Time
}

func newHandlerEnv(t *testing.T, withRedis bool) *handlerEnv {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	env := &handlerEnv{now: now, batch: &fakeBatcher{}, logBuf: &bytes.Buffer{}}
	clock := now
	env.clock = &clock
	if withRedis {
		env.store, env.redis = redistest.Open(t)
	}

	profPKI := makeTestProfileSigningPKI(t, now.Add(-time.Hour), now.Add(60*24*time.Hour))
	signer, err := NewStaticProfileSigner([]*x509.Certificate{profPKI.leafCert, profPKI.interCert}, profPKI.leafKey)
	if err != nil {
		t.Fatal(err)
	}
	env.signer = signer

	_, interCert, interKey, bundlePEM := makeTestDeviceCAWithProdConstraints(t)
	dt, err := enroll.ParseDeviceTrustBundle(bundlePEM)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := NewStaticDeviceCAIssuer(interCert, interKey)
	if err != nil {
		t.Fatal(err)
	}
	env.deviceInter, env.deviceInterKey = interCert, interKey

	// Test Apple Enterprise Attestation root + intermediate.
	appleRootKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	rootTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Test Apple Attest Root"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true, IsCA: true,
	}
	appleRootDER, _ := x509.CreateCertificate(rand.Reader, rootTmpl, rootTmpl, &appleRootKey.PublicKey, appleRootKey)
	appleRoot, _ := x509.ParseCertificate(appleRootDER)
	env.appleInterKey, _ = ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	appleInterDER, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "Test Apple Attest Inter"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageCertSign, BasicConstraintsValid: true, IsCA: true,
	}, appleRoot, &env.appleInterKey.PublicKey, appleRootKey)
	env.appleInter, _ = x509.ParseCertificate(appleInterDER)
	applePool := x509.NewCertPool()
	applePool.AddCert(appleRoot)

	edgeKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x11}, 32))
	acmeKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x22}, 32))
	codeKey := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x33}, 32))
	env.edgeRing, _ = enrolltoken.ParseNonEmptyRing("edge", "1:"+edgeKey)
	env.acmeRing, _ = enrolltoken.ParseNonEmptyRing("acme", "2:"+acmeKey)
	env.pathRing, _ = enrolltoken.ParseNonEmptyRing("path", "6:"+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x66}, 32)))
	codeRing, _ := keyring.ParseRing("code", "1:"+codeKey)

	var store enrollredis.Store
	if env.store != nil {
		store = env.store
	}
	env.h = NewHandler(HandlerDeps{
		Store:            store,
		Batcher:          env.batch,
		EdgeLinkKeys:     env.edgeRing,
		ACMEPermitKeys:   env.acmeRing,
		ACMEPathKeys:     env.pathRing,
		DeviceCodeKeys:   codeRing,
		ProfileSigner:    signer,
		DeviceCAIssuer:   issuer,
		DeviceCATrust:    enroll.NewStaticDeviceCABundle(dt),
		AppleAttest:      appleattest.NewVerifierForTest(applePool),
		EnrolldTokens:    [][]byte{sha256Bytes(enrolldToken)},
		AcmedTokens:      [][]byte{sha256Bytes(acmedToken)},
		ProfileURL:       "https://ca.i10.tech/enroll/apple/profile",
		SCEPURL:          "https://ca.i10.tech/scep/apple-scep",
		ACMEDirectoryURL: DefaultACMEDirectoryURL,
		IMAPHost:         "mail.i10.tech",
		IMAPPort:         993,
		SMTPHost:         "mail.i10.tech",
		SMTPPort:         465,
		Organization:     "i10",
		Now:              func() time.Time { return *env.clock },
		Log:              slog.New(slog.NewJSONHandler(env.logBuf, nil)),
	})
	return env
}

func doReq(h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// newSession stores an open session as the API's POST does (link token signed
// for creation + 30 minutes, the session's own first-attest window 15) and
// returns its id and link token.
func (env *handlerEnv) newSession(t *testing.T, platformUID string) (string, string) {
	t.Helper()
	eidBytes, _ := enrolltoken.NewUUIDv7At(env.now)
	eid := enrolltoken.FormatUUID(eidBytes)
	link, err := enrolltoken.SignLink(env.edgeRing, eidBytes, env.now.Add(30*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if err := env.store.CreateSession(context.Background(), enrollredis.Session{
		ID: eid, ClerkUserID: platformUID, Email: "ada@acme.test", ExpectedEpoch: 3,
		CreatedBy: platformUID, Status: "open", CreatedAtMs: env.now.UnixMilli(),
		ExpiresAtMs: env.now.Add(15 * time.Minute).UnixMilli(), UpdatedAtMs: env.now.UnixMilli(),
	}, env.now); err != nil {
		t.Fatal(err)
	}
	return eid, link
}

var challengeInProfile = regexp.MustCompile(`<key>Challenge</key>\s*<string>([^<]+)</string>`)

// attest runs Phase 2 and returns the SCEP challenge plaintext from the signed
// profile, as the device reads it.
func (env *handlerEnv) attest(t *testing.T, link, serial, udid, product, version string) (attestResponse, string) {
	t.Helper()
	rec := doReq(env.h, "POST", "/enrolld/attest", enrolldToken, attestRequest{
		Token: link, UDID: udid, Serial: serial, Product: product, Version: version,
		AppleSignerSha256: strings.Repeat("ab", 32),
	})
	var ar attestResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &ar)
	if rec.Code != 200 {
		t.Fatalf("attest status = %d", rec.Code)
	}
	if ar.Outcome != "scep" {
		return ar, ""
	}
	der, _ := base64.StdEncoding.DecodeString(ar.Profile)
	p7, err := pkcs7.Parse(der)
	if err != nil {
		t.Fatalf("parse signed SCEP profile: %v", err)
	}
	m := challengeInProfile.FindSubmatch(p7.Content)
	if m == nil {
		t.Fatal("no Challenge in the SCEP profile")
	}
	return ar, string(m[1])
}

// scepCert issues the Phase 4 SCEP leaf step-ca would, from the test device
// intermediate, and returns it with its key hash.
func (env *handlerEnv) scepCert(t *testing.T, serial string) ([]byte, string) {
	t.Helper()
	der, keyHex, _ := env.scepCertAndKey(t, serial)
	return der, keyHex
}

// scepCertAndKey is scepCert with the device's SCEP key, which opens the
// sealed profile.
func (env *handlerEnv) scepCertAndKey(t *testing.T, serial string) ([]byte, string, *rsa.PrivateKey) {
	t.Helper()
	k, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(77), Subject: pkix.Name{CommonName: serial},
		NotBefore: env.now.Add(-time.Minute), NotAfter: env.now.Add(24 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection},
	}, env.deviceInter, &k.PublicKey, env.deviceInterKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	return der, hex.EncodeToString(sum[:]), k
}

var (
	encryptedPayloadInProfile = regexp.MustCompile(`(?s)<key>EncryptedPayloadContent</key>\s*<data>([^<]+)</data>`)
	directoryURLInProfile     = regexp.MustCompile(`<key>DirectoryURL</key>\s*<string>([^<]+)</string>`)
)

// openSealedProfile verifies nothing: it unwraps the signed profile and
// decrypts its payloads with the device's SCEP key, as the device does.
func openSealedProfile(t *testing.T, profileB64 string, key *rsa.PrivateKey) []byte {
	t.Helper()
	der, _ := base64.StdEncoding.DecodeString(profileB64)
	p7, err := pkcs7.Parse(der)
	if err != nil {
		t.Fatalf("parse signed sealed profile: %v", err)
	}
	m := encryptedPayloadInProfile.FindSubmatch(p7.Content)
	if m == nil {
		t.Fatal("no EncryptedPayloadContent in the sealed profile")
	}
	env, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(string(m[1])), ""))
	if err != nil {
		t.Fatal(err)
	}
	inner, err := DecryptCMSEnvelopedData(env, key)
	if err != nil {
		t.Fatalf("decrypt sealed profile: %v", err)
	}
	return inner
}

// scep runs cahookrelay's two hooks for the key, with the challenge the device sent.
func (env *handlerEnv) scep(t *testing.T, challenge, keyHex, serial string) {
	t.Helper()
	ctx := context.Background()
	if d, err := env.store.SCEPClaim(ctx, challenge, keyHex, "tx-"+keyHex[:8], serial, env.now); err != nil || !d.Allow {
		t.Fatalf("SCEPClaim: %+v, %v", d, err)
	}
	if d, err := env.store.SCEPAuthorize(ctx, keyHex, serial, env.now); err != nil || !d.Allow {
		t.Fatalf("SCEPAuthorize: %+v, %v", d, err)
	}
}

func (env *handlerEnv) finish(t *testing.T, certDER []byte, udid *string) (int, finishResponse) {
	t.Helper()
	rec := doReq(env.h, "POST", "/enrolld/finish", enrolldToken, finishRequest{
		CertDer: base64.StdEncoding.EncodeToString(certDER), UDID: udid,
	})
	var fr finishResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &fr)
	return rec.Code, fr
}

func TestHandlerAuthIsolationAndBounds(t *testing.T) {
	h := newHandlerEnv(t, false).h

	// Cross-token isolation: enrolld token cannot reach /acme/finalize and vice versa.
	if rec := doReq(h, "POST", "/acme/finalize", enrolldToken, map[string]string{}); rec.Code != 404 || rec.Body.Len() != 0 {
		t.Fatalf("enrolld token on /acme/finalize = (%d, %q), want bare 404", rec.Code, rec.Body.String())
	}
	if rec := doReq(h, "POST", "/enrolld/peek", acmedToken, map[string]string{"token": "x"}); rec.Code != 404 || rec.Body.Len() != 0 {
		t.Fatalf("acmed token on /enrolld/peek = (%d, %q), want bare 404", rec.Code, rec.Body.String())
	}
	// Missing token, GET method, query string, unknown path, oversize body -> bare 404.
	for _, tc := range []struct {
		method, path, tok string
		body              any
	}{
		{"POST", "/enrolld/peek", "", map[string]string{"token": "x"}},
		{"GET", "/enrolld/peek", enrolldToken, nil},
		{"POST", "/enrolld/peek?a=1", enrolldToken, map[string]string{"token": "x"}},
		{"POST", "/unknown", enrolldToken, map[string]string{}},
		{"POST", "/enrolld/peek", enrolldToken, map[string]string{"pad": strings.Repeat("a", MaxBodyBytes)}},
	} {
		rec := doReq(h, tc.method, tc.path, tc.tok, tc.body)
		if rec.Code != 404 || rec.Body.Len() != 0 {
			t.Errorf("%s %s = (%d, %q), want bare 404", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}
}

func TestHandlerFullMacFlowAndACMEFinalizeRefusals(t *testing.T) {
	env := newHandlerEnv(t, true)
	h, store, batch, now := env.h, env.store, env.batch, env.now
	eid, linkTok := env.newSession(t, "user_ada_"+redistest.ID(t))

	// 1. Phase 1 peek -> returns signed profile.
	rec := doReq(h, "POST", "/enrolld/peek", enrolldToken, peekRequest{Token: linkTok})
	var pr peekResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &pr)
	if rec.Code != 200 || !pr.Live || pr.Profile == "" {
		t.Fatalf("peek = (%d, %+v), want live with signed profile", rec.Code, pr)
	}

	// 2. Phase 2 attest -> returns signed SCEP profile.
	serial := "C02MACFLOW" + redistest.ID(t)[:4]
	const udid = "00008140-001A2B3C4D5E6F70"
	ar, challenge := env.attest(t, linkTok, serial, udid, "Mac15,6", "24D70")
	if ar.Outcome != "scep" || challenge == "" {
		t.Fatalf("attest = %+v", ar)
	}

	// 3. SCEP: the relay's hooks with the challenge the device sent.
	scepDER, scepKeyHex, scepKey := env.scepCertAndKey(t, serial)
	env.scep(t, challenge, scepKeyHex, serial)

	// 4. Phase 4 finish -> mints device, encrypt-then-sign, caches M2, enqueues notice.
	uPtr := udid
	code, fr := env.finish(t, scepDER, &uPtr)
	if code != 200 || fr.Outcome != "sealed" || fr.Profile == "" {
		t.Fatalf("finish = (%d, %s %s)", code, fr.Outcome, fr.Reason)
	}
	sessAfter, _ := store.GetSession(context.Background(), eid)
	if batch.mints() != 1 || len(redistest.Notices(t, env.redis, sessAfter.DeviceID)) != 1 {
		t.Fatalf("mintCalls=%d, want 1 and one notice", batch.mints())
	}

	// The Mac's ACME directory URL carries a path token for THIS device and
	// serial, under the configured directory base.
	m := directoryURLInProfile.FindSubmatch(openSealedProfile(t, fr.Profile, scepKey))
	if m == nil {
		t.Fatal("no DirectoryURL in the Mac's sealed profile")
	}
	tok, ok := strings.CutPrefix(string(m[1]), "https://ca.i10.tech/acme/apple/d/")
	tok, ok2 := strings.CutSuffix(tok, "/directory")
	if !ok || !ok2 || strings.Contains(tok, "/") {
		t.Fatalf("DirectoryURL = %q, want https://ca.i10.tech/acme/apple/d/<token>/directory", m[1])
	}
	claims, err := enrolltoken.VerifyACMEPath(env.pathRing, tok, now)
	if err != nil || claims.DeviceID != sessAfter.DeviceID || claims.Serial != serial || !claims.ExpiresAt.Equal(now.Add(enrolltoken.ACMEPathLifetime)) {
		t.Fatalf("path token = (%+v, %v), want device %s, serial %s, 10 minutes", claims, err, sessAfter.DeviceID, serial)
	}

	// M2 retry with same SCEP key returns IDENTICAL bytes with 0 extra mint calls.
	code, frRetry := env.finish(t, scepDER, nil)
	if code != 200 || frRetry.Outcome != "sealed" || frRetry.Profile != fr.Profile || batch.mints() != 1 {
		t.Fatalf("M2 retry failed: outcome=%s same=%v mintCalls=%d", frRetry.Outcome, frRetry.Profile == fr.Profile, batch.mints())
	}

	// 5. /acme/finalize: build attested EC P-384 key, CSR, and OU permit.
	devUUID, _ := enrolltoken.ParseUUID(sessAfter.DeviceID)
	validOU, _ := enrolltoken.SignACMEPermit(env.acmeRing, devUUID, now.Add(10*time.Minute))

	attKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	attLeafDER, _ := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(99), Subject: pkix.Name{CommonName: "Apple Attest"},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(time.Hour),
		KeyUsage:        x509.KeyUsageDigitalSignature,
		ExtraExtensions: []pkix.Extension{{Id: appleattest.OIDAppleSerialNumber, Value: []byte(serial)}},
	}, env.appleInter, &attKey.PublicKey, env.appleInterKey)

	csrDER, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: serial, OrganizationalUnit: []string{validOU}},
	}, attKey)
	x5cB64 := []string{
		base64.StdEncoding.EncodeToString(attLeafDER),
		base64.StdEncoding.EncodeToString(env.appleInter.Raw),
	}

	finalize := func(ou string, csr []byte) (int, acmeFinalizeResponse) {
		rec := doReq(h, "POST", "/acme/finalize", acmedToken, acmeFinalizeRequest{
			Serial: serial, OU: ou, CSRDer: base64.StdEncoding.EncodeToString(csr), AttestationX5C: x5cB64,
		})
		var af acmeFinalizeResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &af)
		return rec.Code, af
	}
	if code, af := finalize(validOU, csrDER); code != 200 || af.Outcome != "issued" || !strings.Contains(af.CertPEM, "BEGIN CERTIFICATE") {
		t.Fatalf("/acme/finalize valid = (%d, %+v)", code, af)
	}
	if batch.bindCalls != 1 {
		t.Fatalf("bindCalls = %d, want 1", batch.bindCalls)
	}

	// (a) forged OU permit
	if _, af := finalize(strings.Repeat("X", 50), csrDER); af.Outcome != "refused" || af.Reason != "invalid_permit" {
		t.Fatalf("forged permit = %+v, want invalid_permit", af)
	}
	// (b) CSR signed by different key than attested leaf key
	otherKey, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	otherCSR, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: serial, OrganizationalUnit: []string{validOU}},
	}, otherKey)
	if _, af := finalize(validOU, otherCSR); af.Outcome != "refused" || af.Reason != "csr_key_mismatch" {
		t.Fatalf("csr key mismatch = %+v, want csr_key_mismatch", af)
	}
	// (c) CSR with two OUs
	twoOUCSR, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: serial, OrganizationalUnit: []string{validOU, "extra"}},
	}, attKey)
	if _, af := finalize(validOU, twoOUCSR); af.Outcome != "refused" || af.Reason != "csr_ou_count" {
		t.Fatalf("two OUs = %+v, want csr_ou_count", af)
	}

	// (d) Logs must never contain link token, raw serial, or bearer tokens.
	logs := env.logBuf.String()
	for _, secret := range []string{linkTok, serial, validOU, challenge, enrolldToken, acmedToken, "i10dc1.", tok} {
		if strings.Contains(logs, secret) {
			t.Errorf("enrollctl log leaked secret %q", secret)
		}
	}
}

// TestFinishRefusesABindingTheRelayCouldForge: a party that can write
// enroll:scep:* but was never sent the challenge (a Redis writer, or a relay
// that missed this challenge's webhook) binds ITS OWN SCEP key, naming the
// victim's session and challenge hash, without the challenge plaintext. It
// does not cover a compromised relay or step-ca that was sent the plaintext:
// that party can take over an enrollment in SCEP (cahookrelay/main.go, design
// doc 6.5), which is inherent to SCEP.
func TestFinishRefusesABindingTheRelayCouldForge(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, link := env.newSession(t, "user_victim_"+redistest.ID(t))
	serial := "C02VICTIM" + redistest.ID(t)[:4]
	if ar, _ := env.attest(t, link, serial, "udid-victim", "iPhone17,2", "22A3354"); ar.Outcome != "scep" {
		t.Fatalf("attest = %+v", ar)
	}
	sess, _ := env.store.GetSession(ctx, eid)

	attackerDER, attackerKey := env.scepCert(t, serial)
	for name, challenge := range map[string]string{
		"a guessed plaintext": "not-the-victims-challenge",
		"no plaintext":        "",
	} {
		t.Run(name, func(t *testing.T) {
			redistest.PutSCEPKeyBinding(t, env.redis, enrollredis.SCEPKeyBinding{
				EID: eid, ClerkUserID: sess.ClerkUserID, Serial: serial,
				ChalHash: sess.SCEPChalHash, Challenge: challenge, KeySha256: attackerKey,
				TxID: "tx-evil", Status: "authorized", ExpiresAtMs: env.now.Add(5 * time.Minute).UnixMilli(),
			}, 5*time.Minute)
			code, fr := env.finish(t, attackerDER, nil)
			if code != 200 || fr.Outcome != "refused" || fr.Reason != "scep_challenge_mismatch" {
				t.Fatalf("forged binding = (%d, %s %s), want refused scep_challenge_mismatch", code, fr.Outcome, fr.Reason)
			}
			if env.batch.mints() != 0 {
				t.Fatalf("a forged binding reached the mint (%d calls)", env.batch.mints())
			}
		})
	}
}

// TestFinishAppliesTheRelaysRefusal: a SCEP refusal cahookrelay recorded
// refuses the finish and moves the session to refused.
func TestFinishAppliesTheRelaysRefusal(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, link := env.newSession(t, "user_r_"+redistest.ID(t))
	serial := "C02REFUSE" + redistest.ID(t)[:4]
	_, challenge := env.attest(t, link, serial, "udid-r", "iPhone17,2", "22A3354")
	der, keyHex := env.scepCert(t, serial)
	env.scep(t, challenge, keyHex, serial)
	if err := env.store.MarkSCEPRefused(ctx, eid, "bad_template"); err != nil {
		t.Fatal(err)
	}
	if code, fr := env.finish(t, der, nil); code != 200 || fr.Reason != "bad_template" {
		t.Fatalf("finish after a SCEP refusal = (%d, %s %s)", code, fr.Outcome, fr.Reason)
	}
	if sess, _ := env.store.GetSession(ctx, eid); sess.Status != "refused" || sess.Refusal != "bad_template" {
		t.Fatalf("session = %+v, want refused bad_template", sess)
	}
	if env.batch.mints() != 0 {
		t.Fatal("a refused enrollment reached the mint")
	}
}

// sealedFinish is a session ready to finish: attested, through SCEP.
func (env *handlerEnv) sealedFinish(t *testing.T, tag string) (eid string, der []byte, keyHex string) {
	t.Helper()
	eid, link := env.newSession(t, "user_"+tag+"_"+redistest.ID(t))
	serial := "C02" + strings.ToUpper(tag) + redistest.ID(t)[:4]
	_, challenge := env.attest(t, link, serial, "udid-"+tag, "iPhone17,2", "22A3354")
	der, keyHex = env.scepCert(t, serial)
	env.scep(t, challenge, keyHex, serial)
	return eid, der, keyHex
}

// TestOnlyTheSealingMarkerHolderMints: two finishes for one enrollment. A
// holds the sealing marker and is inside its mint; B does not acquire the
// marker, so B never reaches the batcher (before, B could reach it first,
// mint, and leave A to refuse the session terminally). B answers 503
// seal_in_flight; once A has sealed, B's retry gets A's profile.
func TestOnlyTheSealingMarkerHolderMints(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, der, _ := env.sealedFinish(t, "race")

	inMint, release := make(chan struct{}), make(chan struct{})
	env.batch.mintHandler = func(MintRequest) MintResult {
		close(inMint)
		<-release
		return MintResult{OK: true}
	}
	type answer struct {
		code int
		fr   finishResponse
	}
	aDone := make(chan answer, 1)
	go func() {
		code, fr := env.finish(t, der, nil)
		aDone <- answer{code, fr}
	}()
	<-inMint

	if code, _ := env.finish(t, der, nil); code != http.StatusServiceUnavailable {
		t.Fatalf("B while A mints = %d, want 503", code)
	}
	if !strings.Contains(env.logBuf.String(), `"outcome":"seal_in_flight"`) {
		t.Fatalf("B's answer was not logged as seal_in_flight:\n%s", env.logBuf.String())
	}
	if n := env.batch.mints(); n != 1 {
		t.Fatalf("mint calls = %d, want 1 (only the marker holder mints)", n)
	}
	close(release)
	a := <-aDone
	if a.code != 200 || a.fr.Outcome != "sealed" {
		t.Fatalf("A = (%d, %s %s), want sealed", a.code, a.fr.Outcome, a.fr.Reason)
	}
	if n := env.redis.Exists(ctx, enrollredis.SealingKey(eid)).Val(); n != 0 {
		t.Fatal("A left its sealing marker after sealing")
	}
	if code, fr := env.finish(t, der, nil); code != 200 || fr.Outcome != "sealed" || fr.Profile != a.fr.Profile || env.batch.mints() != 1 {
		t.Fatalf("B's retry = (%d, %s, same profile %v, mints %d), want A's profile", code, fr.Outcome, fr.Profile == a.fr.Profile, env.batch.mints())
	}
}

// cacheAfterMarker is a Store on which the sealed cache appears between
// prepareFinish's read and the marker: the moment a holder has just sealed
// but not yet released its marker.
type cacheAfterMarker struct {
	*enrollredis.RedisStore
	reads int
}

func (c *cacheAfterMarker) GetSealedCache(ctx context.Context, eid string) (*enrollredis.SealedCache, error) {
	c.reads++
	if c.reads == 1 {
		return nil, nil
	}
	return c.RedisStore.GetSealedCache(ctx, eid)
}

// TestANonHolderAnswersFromTheSealedCache: B finds another attempt's marker
// and the cache that attempt just wrote: the same key gets the cached
// profile, another key is refused scep_key_conflict, and B mints nothing.
func TestANonHolderAnswersFromTheSealedCache(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, der, keyHex := env.sealedFinish(t, "cache")
	if got, err := env.store.MarkSealing(ctx, eid, "holder-a"); err != nil || !got {
		t.Fatalf("MarkSealing = (%v, %v)", got, err)
	}
	sess, _ := env.store.GetSession(ctx, eid)
	for name, tc := range map[string]struct {
		cachedKey   string
		wantOutcome string
		wantReason  string
	}{
		"same key":    {keyHex, "sealed", ""},
		"another key": {strings.Repeat("ee", 32), "refused", "scep_key_conflict"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := env.redis.Set(ctx, enrollredis.SealedKey(eid), `{"key_sha256":"`+tc.cachedKey+`","device_id":"d","profile_b64":"QUFB"}`, time.Minute).Err(); err != nil {
				t.Fatal(err)
			}
			env.h.deps.Store = &cacheAfterMarker{RedisStore: env.store}
			code, fr := env.finish(t, der, nil)
			if code != 200 || fr.Outcome != tc.wantOutcome || fr.Reason != tc.wantReason {
				t.Fatalf("finish = (%d, %s %s), want %s %s", code, fr.Outcome, fr.Reason, tc.wantOutcome, tc.wantReason)
			}
			if env.batch.mints() != 0 {
				t.Fatal("a finish without the marker minted")
			}
		})
	}
	if s2, _ := env.store.GetSession(ctx, eid); s2.Status != sess.Status {
		t.Fatalf("session = %s, want unchanged %s", s2.Status, sess.Status)
	}
	if tok := env.redis.Get(ctx, enrollredis.SealingKey(eid)).Val(); tok != "holder-a" {
		t.Fatalf("a non-holder touched the holder's marker (now %q)", tok)
	}
}

// TestAHolderWhoseMintFailsReleasesTheMarker: an unavailable mint clears the
// holder's marker, so the device's next attempt mints at once instead of
// waiting SealingTTLSec.
func TestAHolderWhoseMintFailsReleasesTheMarker(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, der, _ := env.sealedFinish(t, "fail")
	env.batch.mintHandler = func(MintRequest) MintResult { return MintResult{Err: ErrUnavailable} }
	if code, _ := env.finish(t, der, nil); code != http.StatusServiceUnavailable {
		t.Fatalf("finish with the database down = %d, want 503", code)
	}
	if n := env.redis.Exists(ctx, enrollredis.SealingKey(eid)).Val(); n != 0 {
		t.Fatal("a failed mint left its sealing marker")
	}
	env.batch.mintHandler = nil
	if code, fr := env.finish(t, der, nil); code != 200 || fr.Outcome != "sealed" || env.batch.mints() != 2 {
		t.Fatalf("next attempt = (%d, %s %s, mints %d), want sealed by a second mint", code, fr.Outcome, fr.Reason, env.batch.mints())
	}
}

// TestFinishRefusesAMintWhoseSealWasLost: the enrollment is minted, nothing
// is cached, and this attempt holds the marker (the attempt that minted it
// released its marker after its seal was lost). Only a marker holder mints,
// so nobody else is sealing: waiting changes nothing, and the finish is
// refused and the session marked refused, instead of 503 until the session
// expires.
func TestFinishRefusesAMintWhoseSealWasLost(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, der, _ := env.sealedFinish(t, "lost")
	env.batch.mintHandler = func(MintRequest) MintResult { return MintResult{RefusalCode: "enrollment_conflict"} }

	if code, fr := env.finish(t, der, nil); code != 200 || fr.Outcome != "refused" || fr.Reason != "enrollment_conflict" {
		t.Fatalf("finish after a lost seal = (%d, %s %s), want refused enrollment_conflict", code, fr.Outcome, fr.Reason)
	}
	if sess, _ := env.store.GetSession(ctx, eid); sess.Status != "refused" || sess.Refusal != "enrollment_conflict" {
		t.Fatalf("session = %+v, want refused enrollment_conflict", sess)
	}
	if n := env.redis.Exists(ctx, enrollredis.SealingKey(eid)).Val(); n != 0 {
		t.Fatal("a refused finish left its sealing marker")
	}
}

// flakySeal fails the first failures SealSession calls, then passes them on.
type flakySeal struct {
	*enrollredis.RedisStore
	failures int
	calls    int
}

func (f *flakySeal) SealSession(ctx context.Context, sess *enrollredis.Session, cache enrollredis.SealedCache, now time.Time) error {
	f.calls++
	if f.calls <= f.failures {
		return errors.New("flaky: redis hiccup")
	}
	return f.RedisStore.SealSession(ctx, sess, cache, now)
}

// TestFinishRetriesTheSealAfterACommit: a brief Redis failure on the first
// SealSession after the commit is retried; the session ends sealed, the
// cache written, one notice queued, and no ERROR is logged.
func TestFinishRetriesTheSealAfterACommit(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, der, keyHex := env.sealedFinish(t, "flaky")
	flaky := &flakySeal{RedisStore: env.store, failures: 1}
	env.h.deps.Store = flaky

	code, fr := env.finish(t, der, nil)
	if code != 200 || fr.Outcome != "sealed" {
		t.Fatalf("finish = (%d, %s %s), want sealed", code, fr.Outcome, fr.Reason)
	}
	if flaky.calls != 2 {
		t.Fatalf("SealSession calls = %d, want 2", flaky.calls)
	}
	sess, _ := env.store.GetSession(ctx, eid)
	if sess.Status != "sealed" || len(redistest.Notices(t, env.redis, sess.DeviceID)) != 1 {
		t.Fatalf("session = %s, want sealed with one notice", sess.Status)
	}
	if cached, _ := env.store.GetSealedCache(ctx, eid); cached == nil || cached.KeySha256 != keyHex || cached.ProfileB64 != fr.Profile {
		t.Fatal("the sealed cache was not written")
	}
	if strings.Contains(env.logBuf.String(), `"level":"ERROR"`) {
		t.Fatalf("a seal that succeeded on retry logged an ERROR:\n%s", env.logBuf.String())
	}

	// Every attempt failing ends with one ERROR after the last.
	env2 := newHandlerEnv(t, true)
	_, der2, _ := env2.sealedFinish(t, "down")
	down := &flakySeal{RedisStore: env2.store, failures: 99}
	env2.h.deps.Store = down
	if code, fr := env2.finish(t, der2, nil); code != 200 || fr.Outcome != "sealed" {
		t.Fatalf("finish with Redis down after the commit = (%d, %s), want the profile anyway", code, fr.Outcome)
	}
	if down.calls != len(sealRetryBackoff)+1 || strings.Count(env2.logBuf.String(), `"level":"ERROR"`) != 1 {
		t.Fatalf("SealSession calls = %d, ERROR lines = %d; want %d and 1", down.calls, strings.Count(env2.logBuf.String(), `"level":"ERROR"`), len(sealRetryBackoff)+1)
	}
}

// hangingSeal makes the first hangs SealSession calls hang until their
// context ends (or, with ignoreCtx, for a fixed sleep whatever the context),
// then passes calls on.
type hangingSeal struct {
	*enrollredis.RedisStore
	hangs     int
	ignoreCtx time.Duration
	calls     int
}

func (h *hangingSeal) SealSession(ctx context.Context, sess *enrollredis.Session, cache enrollredis.SealedCache, now time.Time) error {
	h.calls++
	if h.calls > h.hangs {
		return h.RedisStore.SealSession(ctx, sess, cache, now)
	}
	if h.ignoreCtx > 0 {
		time.Sleep(h.ignoreCtx)
		return errors.New("hanging: socket stuck")
	}
	<-ctx.Done()
	return ctx.Err()
}

// TestEachSealAttemptHasItsOwnDeadline: two SealSession calls that hang until
// their context ends do not spend the whole post-commit budget: attempt 3
// still runs and seals, and the notice is queued. A seal that overruns the
// whole budget (ignoring its context) stops after the attempt it was in,
// logs that one attempt ran, and the notice is still queued on its own clock.
func TestEachSealAttemptHasItsOwnDeadline(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, der, _ := env.sealedFinish(t, "hang")
	hang := &hangingSeal{RedisStore: env.store, hangs: 2}
	env.h.deps.Store = hang
	if code, fr := env.finish(t, der, nil); code != 200 || fr.Outcome != "sealed" {
		t.Fatalf("finish = (%d, %s %s), want sealed", code, fr.Outcome, fr.Reason)
	}
	sess, _ := env.store.GetSession(ctx, eid)
	if hang.calls != 3 || sess.Status != "sealed" {
		t.Fatalf("SealSession calls = %d, session = %s; want 3 and sealed", hang.calls, sess.Status)
	}
	if n := len(redistest.Notices(t, env.redis, sess.DeviceID)); n != 1 {
		t.Fatalf("notices = %d, want 1", n)
	}
	if strings.Contains(env.logBuf.String(), `"level":"ERROR"`) {
		t.Fatalf("a seal that succeeded on attempt 3 logged an ERROR:\n%s", env.logBuf.String())
	}

	env2 := newHandlerEnv(t, true)
	_, der2, _ := env2.sealedFinish(t, "overrun")
	var devID string
	env2.batch.mintHandler = func(req MintRequest) MintResult {
		devID = req.DeviceID
		return MintResult{OK: true}
	}
	slow := &hangingSeal{RedisStore: env2.store, hangs: 99, ignoreCtx: postCommitTimeout + 100*time.Millisecond}
	env2.h.deps.Store = slow
	if code, fr := env2.finish(t, der2, nil); code != 200 || fr.Outcome != "sealed" {
		t.Fatalf("finish with a seal past the budget = (%d, %s), want the profile anyway", code, fr.Outcome)
	}
	logs := env2.logBuf.String()
	if slow.calls != 1 || strings.Contains(logs, "retrying") || strings.Count(logs, `"level":"ERROR"`) != 1 || !strings.Contains(logs, `"attempts":1`) {
		t.Fatalf("SealSession calls = %d, want 1, no retry line and one ERROR with attempts 1:\n%s", slow.calls, logs)
	}
	if n := len(redistest.Notices(t, env2.redis, devID)); devID == "" || n != 1 {
		t.Fatalf("notices for %q after a seal past the budget = %d, want 1", devID, n)
	}
}

// TestFinishSealsWhenTheCallerLeavesDuringTheMint: the connection drops while
// the mint commits. The seal and the notice still land, so the device's retry
// finds its sealed profile instead of a 15-minute 503 loop.
func TestFinishSealsWhenTheCallerLeavesDuringTheMint(t *testing.T) {
	env := newHandlerEnv(t, true)
	ctx := context.Background()
	eid, link := env.newSession(t, "user_d_"+redistest.ID(t))
	serial := "C02DROP" + redistest.ID(t)[:4]
	_, challenge := env.attest(t, link, serial, "udid-d", "iPhone17,2", "22A3354")
	der, keyHex := env.scepCert(t, serial)
	env.scep(t, challenge, keyHex, serial)

	reqCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	env.batch.mintHandler = func(MintRequest) MintResult {
		cancel() // the caller is gone; the transaction committed anyway
		return MintResult{OK: true}
	}
	raw, _ := json.Marshal(finishRequest{CertDer: base64.StdEncoding.EncodeToString(der)})
	req := httptest.NewRequest("POST", "/enrolld/finish", bytes.NewReader(raw)).WithContext(reqCtx)
	req.Header.Set("Authorization", "Bearer "+enrolldToken)
	env.h.ServeHTTP(httptest.NewRecorder(), req)

	cached, err := env.store.GetSealedCache(ctx, eid)
	if err != nil || cached == nil || cached.KeySha256 != keyHex {
		t.Fatalf("sealed cache after a dropped caller = (%v, %v), want this key's profile", cached != nil, err)
	}
	if sess, _ := env.store.GetSession(ctx, eid); sess.Status != "sealed" || len(redistest.Notices(t, env.redis, sess.DeviceID)) != 1 {
		t.Fatalf("session = %s, want sealed with one notice", sess.Status)
	}
	if code, fr := env.finish(t, der, nil); code != 200 || fr.Outcome != "sealed" || fr.Profile != cached.ProfileB64 || env.batch.mints() != 1 {
		t.Fatalf("retry = (%d, %s %s, mints %d), want the cached profile", code, fr.Outcome, fr.Reason, env.batch.mints())
	}
}

// TestPeekIsNotLiveAfterASCEPRefusal: a refusal the relay recorded is
// terminal for Phase 1 too.
func TestPeekIsNotLiveAfterASCEPRefusal(t *testing.T) {
	env := newHandlerEnv(t, true)
	eid, link := env.newSession(t, "user_p_"+redistest.ID(t))
	serial := "C02PEEK" + redistest.ID(t)[:4]
	if ar, _ := env.attest(t, link, serial, "udid-p", "iPhone17,2", "22A3354"); ar.Outcome != "scep" {
		t.Fatalf("attest = %+v", ar)
	}
	peek := func() peekResponse {
		rec := doReq(env.h, "POST", "/enrolld/peek", enrolldToken, peekRequest{Token: link})
		var pr peekResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &pr)
		return pr
	}
	if !peek().Live {
		t.Fatal("an attested session was not live")
	}
	if err := env.store.MarkSCEPRefused(context.Background(), eid, "serial_mismatch"); err != nil {
		t.Fatal(err)
	}
	if pr := peek(); pr.Live || pr.Profile != "" {
		t.Fatal("peek after a SCEP refusal was live")
	}
}

// TestFinishSealsBeforeItMints: with the signer unable to sign, finish answers
// 503 and nothing is minted.
func TestFinishSealsBeforeItMints(t *testing.T) {
	env := newHandlerEnv(t, true)
	_, link := env.newSession(t, "user_s_"+redistest.ID(t))
	serial := "C02SEAL" + redistest.ID(t)[:4]
	_, challenge := env.attest(t, link, serial, "udid-s", "iPhone17,2", "22A3354")
	der, keyHex := env.scepCert(t, serial)
	env.scep(t, challenge, keyHex, serial)

	future := env.now.Add(365 * 24 * time.Hour)
	env.signer.Now = func() time.Time { return future }
	if code, _ := env.finish(t, der, nil); code != http.StatusServiceUnavailable {
		t.Fatalf("finish with no signer = %d, want 503", code)
	}
	if env.batch.mints() != 0 {
		t.Fatalf("finish minted %d device(s) it could not deliver", env.batch.mints())
	}
}

// TestLinkTokenCoversTheThirtyMinuteRetryWindow (M4): the link is signed for
// creation + 30 minutes, so attest retries chained inside the session's own
// windows keep working past 15 minutes, up to the hard cap and not beyond.
func TestLinkTokenCoversTheThirtyMinuteRetryWindow(t *testing.T) {
	env := newHandlerEnv(t, true)
	_, link := env.newSession(t, "user_w_"+redistest.ID(t))
	serial := "C02WIN" + redistest.ID(t)[:4]
	at := func(d time.Duration) attestResponse {
		*env.clock = env.now.Add(d)
		ar, _ := env.attest(t, link, serial, "udid-w", "iPhone17,2", "22A3354")
		return ar
	}
	for _, d := range []time.Duration{5 * time.Minute, 14 * time.Minute, 23 * time.Minute, 29*time.Minute + 59*time.Second} {
		if ar := at(d); ar.Outcome != "scep" {
			t.Fatalf("attest at +%s = %+v, want scep", d, ar)
		}
	}
	if ar := at(30*time.Minute + time.Second); ar.Outcome != "refused" || ar.Reason != "enrollment_expired" {
		t.Fatalf("attest past the hard cap = %+v, want enrollment_expired", ar)
	}

	// A session never attested is not live past its own 15 minutes, whatever the token says.
	_, link2 := env.newSession(t, "user_w2_"+redistest.ID(t))
	*env.clock = env.now.Add(16 * time.Minute)
	rec := doReq(env.h, "POST", "/enrolld/peek", enrolldToken, peekRequest{Token: link2})
	var pr peekResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &pr)
	if pr.Live {
		t.Fatal("an unattested session was live after 15 minutes")
	}
}

// TestPhase4LeafRefusesAnUnknownEKU: the SCEP leaf carries emailProtection and
// nothing else, including no EKU Go cannot name.
func TestPhase4LeafRefusesAnUnknownEKU(t *testing.T) {
	env := newHandlerEnv(t, false)
	k, _ := rsa.GenerateKey(rand.Reader, 2048)
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(78), Subject: pkix.Name{CommonName: "C02EKU"},
		NotBefore: env.now.Add(-time.Minute), NotAfter: env.now.Add(24 * time.Hour),
		KeyUsage:           x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:        []x509.ExtKeyUsage{x509.ExtKeyUsageEmailProtection},
		UnknownExtKeyUsage: []asn1.ObjectIdentifier{{1, 3, 6, 1, 4, 1, 99999, 1}},
	}, env.deviceInter, &k.PublicKey, env.deviceInterKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, reason := verifyPhase4SCEPLeaf(der, env.h.deps.DeviceCATrust, env.now); reason != "cert_bad_eku" {
		t.Fatalf("leaf with an unknown EKU = %q, want cert_bad_eku", reason)
	}
	good, _ := env.scepCert(t, "C02EKU")
	if _, _, reason := verifyPhase4SCEPLeaf(good, env.h.deps.DeviceCATrust, env.now); reason != "" {
		t.Fatalf("a plain emailProtection leaf = %q", reason)
	}
}
