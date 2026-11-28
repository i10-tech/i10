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
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

// noRedis is a Store every ACME call of which fails the test: the requests
// it serves must never reach Redis. (Any other call is a nil embedded
// interface and panics, which acmed answers 500.)
type noRedis struct {
	enrollredis.Store
	t *testing.T
}

func (n noRedis) touched() { n.t.Helper(); n.t.Error("touched Redis") }

func (n noRedis) CreateACMEOrder(context.Context, enrollredis.ACMEOrder, enrollredis.ACMEAuthz, string, time.Duration, int, time.Time) (string, error) {
	n.touched()
	return "", nil
}

func (n noRedis) GetACMEOrder(context.Context, string) (*enrollredis.ACMEOrder, error) {
	n.touched()
	return nil, nil
}

func (n noRedis) MoveACMEOrder(context.Context, enrollredis.ACMEOrderMove) (enrollredis.ACMEResult, error) {
	n.touched()
	return enrollredis.ACMEResult{}, nil
}

func (n noRedis) GetACMEAuthz(context.Context, string) (*enrollredis.ACMEAuthz, error) {
	n.touched()
	return nil, nil
}

func (n noRedis) AnswerACMEChallenge(context.Context, enrollredis.ACMEChallengeAnswer) (enrollredis.ACMEResult, error) {
	n.touched()
	return enrollredis.ACMEResult{}, nil
}

func (n noRedis) GetACMECert(context.Context, string) (*enrollredis.ACMECert, error) {
	n.touched()
	return nil, nil
}

// testPathRing is the ENROLL_ACME_PATH_KEYS ring of the handlers built
// without a test world.
func testPathRing(t *testing.T) *enrolltoken.Ring {
	t.Helper()
	return nonceRing(t, ringKey("8", 8))
}

// pathBase signs a path token for serial as enrollctl would and returns the
// URL path it opens (/acme/apple/d/<token>).
func pathBase(t *testing.T, ring *enrolltoken.Ring, serial string, now time.Time) string {
	t.Helper()
	dev, _ := enrolltoken.NewUUIDv7At(now)
	tok, err := enrolltoken.SignACMEPath(ring, dev, serial, now.Add(enrolltoken.ACMEPathLifetime))
	if err != nil {
		t.Fatal(err)
	}
	return "/acme/apple/d/" + tok
}

func nonceRing(t *testing.T, spec string) *enrolltoken.Ring {
	t.Helper()
	r, err := enrolltoken.ParseNonEmptyRing("nonce", spec)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func ringKey(id string, b byte) string {
	return id + ":" + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{b}, 32))
}

func TestNewNonceAndRefusalsBeforeAuthWriteNothing(t *testing.T) {
	h := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: nonceRing(t, ringKey("1", 1)), PathKeys: testPathRing(t)})
	base := pathBase(t, testPathRing(t), "C02NONCE", time.Now())
	for _, m := range []string{http.MethodHead, http.MethodGet} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(m, base+"/new-nonce", nil))
		if n := rec.Header().Get("Replay-Nonce"); len(n) != NonceLen {
			t.Fatalf("%s new-nonce gave %q", m, n)
		}
	}

	// Unauthenticated refusals carry no Replay-Nonce and never reach Redis.
	post := func(path, ct string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", ct)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	for name, rec := range map[string]*httptest.ResponseRecorder{
		"415":           post(base+"/new-order", "application/json", []byte("{}")),
		"413":           post(base+"/new-order", "application/jose+json", make([]byte, MaxBodyBytes+1)),
		"404":           post(base+"/order/x", "application/jose+json", []byte("{}")),
		"malformed JWS": post(base+"/new-order", "application/jose+json", []byte("{")),
	} {
		if rec.Header().Get("Replay-Nonce") != "" {
			t.Errorf("%s answer carried a Replay-Nonce", name)
		}
	}

	// A badNonce problem carries one, so the client can retry.
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jws, _ := SignFlattenedJWS(key, ProtectedHeader{
		Nonce: strings.Repeat("A", NonceLen), URL: "https://ca.i10.tech" + base + "/new-order",
		KID: "https://ca.i10.tech" + base + "/acct/abcdefgh12",
	}, []byte("{}"))
	rec := post(base+"/new-order", "application/jose+json", jws)
	var p Problem
	_ = json.Unmarshal(rec.Body.Bytes(), &p)
	if p.Type != ProblemBadNonce || rec.Header().Get("Replay-Nonce") == "" {
		t.Fatalf("forged nonce = (%+v, nonce %q), want badNonce with a fresh nonce", p, rec.Header().Get("Replay-Nonce"))
	}
}

func TestNonceForgedExpiredWrongKidAndMalformed(t *testing.T) {
	now := time.Now().UTC()
	m := nonceMinter{ring: nonceRing(t, ringKey("1", 1)+","+ringKey("2", 2))}
	good, err := m.issue(now)
	if err != nil {
		t.Fatal(err)
	}
	if left, err := m.check(good, now); err != nil || left > nonceLifetime || left < nonceLifetime-2*time.Second {
		t.Fatalf("a fresh nonce = (%v, %v)", left, err)
	}

	raw, _ := base64.RawURLEncoding.DecodeString(good)
	flip := func(i int) string {
		b := append([]byte{}, raw...)
		b[i] ^= 1
		return base64.RawURLEncoding.EncodeToString(b)
	}
	other, _ := nonceMinter{ring: nonceRing(t, ringKey("9", 9))}.issue(now)
	rotatedOut, _ := nonceMinter{ring: nonceRing(t, ringKey("2", 2))}.issue(now)

	for name, tc := range map[string]struct {
		nonce string
		at    time.Time
		want  error
	}{
		"forged MAC":                   {flip(len(raw) - 1), now, errNonceForged},
		"forged random":                {flip(3), now, errNonceForged},
		"forged expiry":                {flip(19), now, errNonceForged},
		"unknown kid":                  {other, now, errNonceForged},
		"expired":                      {good, now.Add(nonceLifetime + time.Second), errNonceExpired},
		"too short":                    {good[:NonceLen-1], now, errNonceMalformed},
		"bad alphabet":                 {strings.Repeat("+", NonceLen), now, errNonceMalformed},
		"non-canonical last character": {good[:NonceLen-1] + nonCanonicalTail(good), now, errNonceMalformed},
	} {
		if _, err := m.check(tc.nonce, tc.at); err != tc.want {
			t.Errorf("%s: check = %v, want %v", name, err, tc.want)
		}
	}
	// A nonce from a key still in the ring (rotation) verifies.
	if _, err := m.check(rotatedOut, now); err != nil {
		t.Fatalf("a nonce under the ring's second key = %v", err)
	}
}

// nonCanonicalTail changes only the unused low bits of the last base64url
// character (37 bytes in 50 characters leave 4 spare bits).
func nonCanonicalTail(n string) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	i := strings.IndexByte(alphabet, n[len(n)-1])
	return string(alphabet[i^1])
}

func TestACMEStateIsBoundedAndOwned(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	acctKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&acctKey.PublicKey)

	serial := "C02EXPIRE"
	d := w.mac(serial)

	// newAccount ignores contact: nothing the client chose is stored.
	jws, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-account"), JWK: jwk},
		[]byte(`{"termsOfServiceAgreed":true,"contact":["mailto:attacker@example.com"]}`))
	rec := w.postJWS(d.url("/new-account"), jws, "")
	if rec.Code != 201 || strings.Contains(rec.Body.String(), "attacker") {
		t.Fatalf("new-account = (%d, %s)", rec.Code, rec.Body.String())
	}
	kid := rec.Header().Get("Location")
	if strings.Contains(kid, "attacker") {
		t.Fatalf("account URL carries the contact: %s", kid)
	}

	// An order, its authz and its challenge; then the authz expires.
	oJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-order"), KID: kid},
		[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"`+serial+`"}]}`))
	oRec := w.postJWS(d.url("/new-order"), oJWS, "")
	var ob struct {
		Authorizations []string `json:"authorizations"`
		Finalize       string   `json:"finalize"`
	}
	_ = json.Unmarshal(oRec.Body.Bytes(), &ob)
	aJWS, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: ob.Authorizations[0], KID: kid}, nil)
	aRec := w.postJWS(ob.Authorizations[0], aJWS, "")
	var ab struct {
		Challenges []struct {
			Token string `json:"token"`
			URL   string `json:"url"`
		} `json:"challenges"`
	}
	_ = json.Unmarshal(aRec.Body.Bytes(), &ab)
	chal := ab.Challenges[0]
	authzID := ob.Authorizations[0][strings.LastIndex(ob.Authorizations[0], "/")+1:]
	if ttl := w.redis.TTL(ctx, enrollredis.ACMEAuthzKey(authzID)).Val(); ttl <= 0 || ttl > defaultStateLifetime {
		t.Fatalf("authz TTL = %v, want at most %v", ttl, defaultStateLifetime)
	}

	nn := sha256.Sum256([]byte(chal.Token))
	leaf, _ := w.makeAttestCert(w.appleInter, w.appleKey, serial, nn[:])
	cp, _ := json.Marshal(map[string]string{"attObj": base64.RawURLEncoding.EncodeToString(EncodeAppleAttestationCBOR([][]byte{leaf, w.appleInter.Raw}))})
	// The authz and order expire with the path token they were made under,
	// whose expiry acmed checks first: past it, every URL is a bare 404.
	authzKey, _ := w.store.GetACMEAuthz(ctx, authzID)
	if authzKey == nil || authzKey.Expires.After(w.now.Add(enrolltoken.ACMEPathLifetime)) {
		t.Fatalf("authz = %+v, want it to expire with the path token", authzKey)
	}
	start := w.now
	w.now = start.Add(defaultStateLifetime + time.Second)
	nonceAfter, _ := w.handler.issueNonce()
	cj, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: nonceAfter, URL: chal.URL, KID: kid}, cp)
	if cRec := w.postJWS(chal.URL, cj, ""); cRec.Code != 404 || cRec.Header().Get("Replay-Nonce") != "" {
		t.Fatalf("challenge after the path token expired = (%d, nonce %q), want a bare 404", cRec.Code, cRec.Header().Get("Replay-Nonce"))
	}
	w.now = start

	// An authz saved with an earlier expiry than its token: challenge and
	// finalize refuse it as expired.
	authzKey.Expires = w.now.Add(time.Second)
	w.put(enrollredis.ACMEAuthzKey(authzKey.ID), authzKey, time.Minute)
	ordID := strings.TrimSuffix(ob.Finalize[strings.Index(ob.Finalize, "/order/")+len("/order/"):], "/finalize")
	ord, _ := w.store.GetACMEOrder(ctx, ordID)
	ord.Expires = authzKey.Expires
	w.put(enrollredis.ACMEOrderKey(ord.ID), ord, time.Minute)
	w.now = w.now.Add(2 * time.Second)
	cj, _ = SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: chal.URL, KID: kid}, cp)
	cRec := w.postJWS(chal.URL, cj, "")
	var p Problem
	_ = json.Unmarshal(cRec.Body.Bytes(), &p)
	if cRec.Code != 403 || p.Type != ProblemUnauthorized || !strings.Contains(p.Detail, "expired") {
		t.Fatalf("challenge on an expired authz = (%d, %+v)", cRec.Code, p)
	}
	fp, _ := json.Marshal(map[string]string{"csr": "AA"})
	fj, _ := SignFlattenedJWS(acctKey, ProtectedHeader{Nonce: w.getNonce(), URL: ob.Finalize, KID: kid}, fp)
	fRec := w.postJWS(ob.Finalize, fj, "")
	_ = json.Unmarshal(fRec.Body.Bytes(), &p)
	if fRec.Code != 403 || !strings.Contains(p.Detail, "expired") {
		t.Fatalf("finalize on an expired order = (%d, %+v)", fRec.Code, p)
	}
	w.now = start
}

func TestACMECertificateServesOnlyItsAccount(t *testing.T) {
	w := newTestACMEWorld(t)
	d := w.mac("C02CERT")
	owner, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ownerKID := w.registerAccount(d, owner)
	otherKID := w.registerAccount(d, other)
	ownerID := w.handler.parseAccountURL(route{base: d.base}, ownerKID).Thumbprint

	certID := "cert" + base64.RawURLEncoding.EncodeToString([]byte(w.now.String()))[:12]
	w.put(enrollredis.ACMECertKey(certID), enrollredis.ACMECert{AccountID: ownerID, DeviceID: d.id, PEM: "-----BEGIN CERTIFICATE-----\n", Expires: w.now.Add(time.Minute)}, time.Minute)
	url := d.url("/certificate/" + certID)
	fetch := func(key *ecdsa.PrivateKey, kid string) *httptest.ResponseRecorder {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: url, KID: kid}, nil)
		return w.postJWS(url, j, "")
	}
	if rec := fetch(other, otherKID); rec.Code != 401 || strings.Contains(rec.Body.String(), "BEGIN CERTIFICATE") {
		t.Fatalf("another account's fetch = (%d, %s)", rec.Code, rec.Body.String())
	}
	if rec := fetch(owner, ownerKID); rec.Code != 200 {
		t.Fatalf("the owner's fetch = %d", rec.Code)
	}
}

func TestJWSRefusesTrailingDataAndUnexpectedJWKMembers(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	const url = "https://ca.i10.tech/acme/apple/new-account"
	valid, err := SignFlattenedJWS(key, ProtectedHeader{Nonce: "n", URL: url, JWK: jwk}, []byte("{}"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseFlattenedJWS(valid, url, true); err != nil {
		t.Fatalf("valid JWS refused: %v", err)
	}
	if _, err := ParseFlattenedJWS(append(append([]byte{}, valid...), " \n"...), url, true); err != nil {
		t.Fatalf("trailing whitespace refused: %v", err)
	}
	for _, tail := range []string{"[1]", `"x"`, "1", "true", "garbage", "{}", "}"} {
		if _, err := ParseFlattenedJWS(append(append([]byte{}, valid...), tail...), url, true); err == nil {
			t.Errorf("envelope with trailing %q accepted", tail)
		}
	}

	// The same rule inside the protected header.
	var env FlattenedJWS
	_ = json.Unmarshal(valid, &env)
	prot, _ := base64.RawURLEncoding.DecodeString(env.Protected)
	for _, tail := range []string{"[1]", `"x"`, "1", "true"} {
		env2 := env
		env2.Protected = base64.RawURLEncoding.EncodeToString(append(append([]byte{}, prot...), tail...))
		b, _ := json.Marshal(env2)
		if _, err := ParseFlattenedJWS(b, url, true); err == nil {
			t.Errorf("protected header with trailing %q accepted", tail)
		}
	}

	var members map[string]any
	_ = json.Unmarshal(jwk, &members)
	withMember := func(k string, v any) json.RawMessage {
		m := map[string]any{}
		for kk, vv := range members {
			m[kk] = vv
		}
		m[k] = v
		b, _ := json.Marshal(m)
		return b
	}
	for _, k := range []string{"kid", "use", "key_ops", "alg"} {
		v := any("x")
		if k == "key_ops" {
			v = []string{"verify"}
		}
		if _, _, _, err := ParsePublicECJWK(withMember(k, v), "ES256"); err != nil {
			t.Errorf("JWK with RFC 7517 member %q refused: %v", k, err)
		}
	}
	for _, k := range []string{"d", "x5c", "x5u", "x5t", "x5t#S256", "evil"} {
		if _, _, _, err := ParsePublicECJWK(withMember(k, "x"), "ES256"); err == nil {
			t.Errorf("JWK with member %q accepted", k)
		}
	}
	if _, _, _, err := ParsePublicECJWK(append(append([]byte{}, jwk...), "[1]"...), "ES256"); err == nil {
		t.Error("JWK with trailing data accepted")
	}
}

func TestCBORRefusesSemanticTags(t *testing.T) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "x"},
		NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour),
	}
	leaf, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	plain := EncodeAppleAttestationCBOR([][]byte{leaf})
	if _, err := ParseAppleAttestationCBOR(plain); err != nil {
		t.Fatalf("untagged object refused: %v", err)
	}
	// Tag 24 (embedded CBOR) around the whole object, and tag 2 (bignum) around a byte string.
	for name, obj := range map[string][]byte{
		"tag around the object": append([]byte{0xd8, 24}, plain...),
		"tag on the root map":   append([]byte{0xc0}, plain...),
	} {
		if _, err := ParseAppleAttestationCBOR(obj); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	// A tag deep inside: the x5c entry wrapped in tag 2.
	var tagged []byte
	tagged = appendCBORHeader(tagged, 5, 2)
	tagged = appendCBORText(tagged, "fmt")
	tagged = appendCBORText(tagged, "apple")
	tagged = appendCBORText(tagged, "attStmt")
	tagged = appendCBORHeader(tagged, 5, 1)
	tagged = appendCBORText(tagged, "x5c")
	tagged = appendCBORHeader(tagged, 4, 1)
	tagged = append(tagged, 0xc2)
	tagged = appendCBORHeader(tagged, 2, uint64(len(leaf)))
	tagged = append(tagged, leaf...)
	if _, err := ParseAppleAttestationCBOR(tagged); err == nil {
		t.Error("a tagged x5c entry accepted")
	}
}

// panicStore panics on an order read with a value that carries request data.
type panicStore struct{ enrollredis.Store }

func (panicStore) GetACMEOrder(_ context.Context, id string) (*enrollredis.ACMEOrder, error) {
	panic("boom on order " + id)
}

// TestAPanicLogsNeitherThePathNorThePanicValue: the recovered panic's log line
// names neither the path token, nor the serial it carries, nor anything from
// the panic value.
func TestAPanicLogsNeitherThePathNorThePanicValue(t *testing.T) {
	now := time.Now().UTC()
	ring := testPathRing(t)
	var logs bytes.Buffer
	h := NewHandler(HandlerDeps{
		Store: panicStore{}, NonceKeys: nonceRing(t, ringKey("1", 1)), PathKeys: ring,
		Now: func() time.Time { return now }, Log: slog.New(slog.NewJSONHandler(&logs, nil)),
	})
	const serial = "C02PANICSERIAL"
	dev, _ := enrolltoken.NewUUIDv7At(now)
	tok, _ := enrolltoken.SignACMEPath(ring, dev, serial, now.Add(enrolltoken.ACMEPathLifetime))
	base := "https://ca.i10.tech/acme/apple/d/" + tok
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	kid, _ := h.accountURL(route{base: base}, jwk)
	nonce, _ := h.issueNonce()
	url := base + "/order/orderidpanic1"
	j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: url, KID: kid}, nil)
	req := httptest.NewRequest(http.MethodPost, strings.TrimPrefix(url, "https://ca.i10.tech"), bytes.NewReader(j))
	req.Header.Set("Content-Type", "application/jose+json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	out := logs.String()
	if rec.Code != 500 || !strings.Contains(out, "acmed panic recovered") {
		t.Fatalf("panicking request = %d, logs:\n%s", rec.Code, out)
	}
	for _, secret := range []string{tok, serial, "boom", "orderidpanic1", "/acme/apple/d/"} {
		if strings.Contains(out, secret) {
			t.Errorf("the panic log carries %q:\n%s", secret, out)
		}
	}
}
