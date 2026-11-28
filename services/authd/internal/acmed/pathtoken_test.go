package acmed

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollctl"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

// TestABadPathTokenIs404AndTouchesNoRedis: without a valid, unexpired token
// for this ring, every URL (directory, new-nonce, a well-formed signed JWS) is
// a bare 404 with no Replay-Nonce, through a Store every ACME call of which
// fails the test.
func TestABadPathTokenIs404AndTouchesNoRedis(t *testing.T) {
	now := time.Now().UTC()
	ring := testPathRing(t)
	h := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: nonceRing(t, ringKey("1", 1)), PathKeys: ring, Now: func() time.Time { return now }})

	dev, _ := enrolltoken.NewUUIDv7At(now)
	good, _ := enrolltoken.SignACMEPath(ring, dev, "C02BAD", now.Add(enrolltoken.ACMEPathLifetime))
	raw, _ := base64.RawURLEncoding.DecodeString(good)
	flip := func(i int) string {
		b := append([]byte{}, raw...)
		b[i] ^= 1
		return base64.RawURLEncoding.EncodeToString(b)
	}
	expired, _ := enrolltoken.SignACMEPath(ring, dev, "C02BAD", now.Add(-time.Second))
	otherRing, _ := enrolltoken.SignACMEPath(nonceRing(t, ringKey("8", 9)), dev, "C02BAD", now.Add(time.Minute))

	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	for name, prefix := range map[string]string{
		"no token (the old URLs)": "/acme/apple",
		"an empty token":          "/acme/apple/d/",
		"garbage":                 "/acme/apple/d/not-a-token",
		"a flipped MAC":           "/acme/apple/d/" + flip(len(raw)-1),
		"another device":          "/acme/apple/d/" + flip(3),
		"another serial":          "/acme/apple/d/" + flip(1+16+4),
		"expired":                 "/acme/apple/d/" + expired,
		"another ring":            "/acme/apple/d/" + otherRing,
	} {
		nonce, _ := h.issueNonce()
		jws, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: "https://ca.i10.tech" + prefix + "/new-account", JWK: jwk}, []byte("{}"))
		post := httptest.NewRequest(http.MethodPost, prefix+"/new-account", strings.NewReader(string(jws)))
		post.Header.Set("Content-Type", "application/jose+json")
		for _, req := range []*http.Request{
			httptest.NewRequest(http.MethodGet, prefix+"/directory", nil),
			httptest.NewRequest(http.MethodHead, prefix+"/new-nonce", nil),
			post,
		} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != 404 || rec.Body.Len() != 0 || rec.Header().Get("Replay-Nonce") != "" {
				t.Errorf("%s: %s %s = (%d, %q, nonce %q), want a bare 404", name, req.Method, req.URL.Path, rec.Code, rec.Body.String(), rec.Header().Get("Replay-Nonce"))
			}
		}
	}

	// The same requests under the good token are served.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/acme/apple/d/"+good+"/directory", nil))
	if rec.Code != 200 {
		t.Fatalf("directory under a good token = %d", rec.Code)
	}
}

// TestAPathTokenOrdersOnlyItsSerial: a token for serial A cannot order serial
// B, and the refusal reaches no Redis.
func TestAPathTokenOrdersOnlyItsSerial(t *testing.T) {
	now := time.Now().UTC()
	ring := testPathRing(t)
	h := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: nonceRing(t, ringKey("1", 1)), PathKeys: ring, Now: func() time.Time { return now }})
	base := "https://ca.i10.tech" + pathBase(t, ring, "C02SERIALA", now)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	acct, _ := h.accountURL(route{base: base}, jwk)
	nonce, _ := h.issueNonce()
	jws, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: base + "/new-order", KID: acct},
		[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"C02SERIALB"}]}`))
	req := httptest.NewRequest(http.MethodPost, strings.TrimPrefix(base, "https://ca.i10.tech")+"/new-order", strings.NewReader(string(jws)))
	req.Header.Set("Content-Type", "application/jose+json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 || problemType(t, rec) != ProblemRejectedIdentifier {
		t.Fatalf("order for another serial = (%d, %s), want 403 rejectedIdentifier", rec.Code, rec.Body.String())
	}
}

// TestObjectsUnderOneDeviceAreRefusedUnderAnother: one account key, two
// sealed Macs. An order, its authz and challenge, its finalize and a
// certificate made under A's token cannot be read, answered or finalized under
// B's token, even for the same account and serial.
func TestObjectsUnderOneDeviceAreRefusedUnderAnother(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	a := w.mac("C02SHARED")
	b := w.mac("C02SHARED")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	_, orderURL, chal, cp, _ := w.openChallenge(a, key)
	kidB := w.registerAccount(b, key)
	under := func(u string) string { return b.base + strings.TrimPrefix(u, a.base) }

	certID := "certshared" + strings.Repeat("x", 6)
	thumb := w.handler.parseAccountURL(route{base: b.base}, kidB).Thumbprint
	w.put(enrollredis.ACMECertKey(certID), enrollredis.ACMECert{AccountID: thumb, DeviceID: a.id, PEM: "-----BEGIN CERTIFICATE-----\n", Expires: w.now.Add(time.Minute)}, time.Minute)
	orderID := orderURL[strings.LastIndex(orderURL, "/")+1:]
	order, _ := w.store.GetACMEOrder(ctx, orderID)
	spent := w.spy.spentCount()
	for name, tc := range map[string]struct {
		url     string
		payload []byte
	}{
		"order":       {under(orderURL), nil},
		"authz":       {under(a.url("/authz/" + order.AuthzID)), nil},
		"challenge":   {under(chal.URL), cp},
		"poll":        {under(chal.URL), nil},
		"finalize":    {under(orderURL + "/finalize"), []byte(`{"csr":"AA"}`)},
		"certificate": {b.url("/certificate/" + certID), nil},
	} {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: tc.url, KID: kidB}, tc.payload)
		if rec := w.postJWS(tc.url, j, ""); rec.Code != 401 || problemType(t, rec) != ProblemUnauthorized || strings.Contains(rec.Body.String(), "BEGIN") {
			t.Errorf("%s under another device's token = (%d, %s), want 401", name, rec.Code, rec.Body.String())
		}
	}
	if w.spy.spentCount() != spent {
		t.Fatalf("a refused request spent a nonce: %v", w.spy.spent[spent:])
	}
	if o, _ := w.store.GetACMEOrder(ctx, orderID); o.Status != "pending" {
		t.Fatalf("order = %s, want untouched pending", o.Status)
	}
}

// TestReadOnlyRequestsWriteNothing: POST-as-GET on an account, an order, an
// authz, a challenge and a certificate, and a challenge answered again after
// its order is ready, spend no nonce and write no key; a replay of any of
// them is still answered.
func TestReadOnlyRequestsWriteNothing(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	d := w.mac("C02READ")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid, orderURL, chal, cp, attKey := w.openChallenge(d, key)
	cj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: chal.URL, KID: kid}, cp)
	if rec := w.postJWS(chal.URL, cj, ""); rec.Code != 200 {
		t.Fatalf("challenge = (%d, %s)", rec.Code, rec.Body.String())
	}
	permit, _ := enrolltoken.SignACMEPermit(w.acmeRing, d.uuid, w.now.Add(10*time.Minute))
	csr, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: d.serial, OrganizationalUnit: []string{permit}},
	}, attKey)
	fp, _ := json.Marshal(map[string]string{"csr": base64.RawURLEncoding.EncodeToString(csr)})
	fj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: orderURL + "/finalize", KID: kid}, fp)
	frec := w.postJWS(orderURL+"/finalize", fj, "")
	var fin struct {
		Certificate    string   `json:"certificate"`
		Authorizations []string `json:"authorizations"`
	}
	_ = json.Unmarshal(frec.Body.Bytes(), &fin)
	if frec.Code != 200 || fin.Certificate == "" {
		t.Fatalf("finalize = (%d, %s)", frec.Code, frec.Body.String())
	}

	spent := w.spy.spentCount()
	for name, tc := range map[string]struct {
		url     string
		payload []byte
	}{
		"account":                  {kid, nil},
		"order":                    {orderURL, nil},
		"authz":                    {fin.Authorizations[0], nil},
		"challenge poll":           {chal.URL, nil},
		"challenge answered again": {chal.URL, cp},
		"certificate":              {fin.Certificate, nil},
	} {
		nonce := w.getNonce()
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: tc.url, KID: kid}, tc.payload)
		for i := 0; i < 2; i++ {
			if rec := w.postJWS(tc.url, j, ""); rec.Code != 200 {
				t.Errorf("%s (try %d) = (%d, %s), want 200", name, i+1, rec.Code, rec.Body.String())
			}
		}
		if n := w.redis.Exists(ctx, enrollredis.ACMEUsedNonceKey(nonce)).Val(); n != 0 {
			t.Errorf("%s spent its nonce", name)
		}
	}
	if w.spy.spentCount() != spent {
		t.Fatalf("a read-only request spent a nonce: %v", w.spy.spent[spent:])
	}
}

// TestRefusedStateChangesWriteNothing: a new-order past the device's cap, a
// response to a challenge that is not pending, a malformed challenge
// response, and a finalize refused on its CSR or its order's state spend no
// nonce and write nothing. A nonce already spent is badNonce on an allowed
// state change (new-order, a pending challenge's response, a ready order's
// finalize), which then writes nothing.
func TestRefusedStateChangesWriteNothing(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	d := w.mac("C02CAP")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid := w.registerAccount(d, key)
	order := func(nonce string) *httptest.ResponseRecorder {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: d.url("/new-order"), KID: kid},
			[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"C02CAP"}]}`))
		return w.postJWS(d.url("/new-order"), j, "")
	}
	for i := 0; i < w.handler.deps.MaxOrdersPerDevice; i++ {
		if rec := order(w.getNonce()); rec.Code != 201 {
			t.Fatalf("order %d = (%d, %s)", i+1, rec.Code, rec.Body.String())
		}
	}
	capped := w.getNonce()
	if rec := order(capped); rec.Code != 429 || problemType(t, rec) != ProblemRateLimited {
		t.Fatalf("order past the cap = (%d, %s), want 429", rec.Code, rec.Body.String())
	}
	if n := w.redis.Exists(ctx, enrollredis.ACMEUsedNonceKey(capped)).Val(); n != 0 {
		t.Fatal("an order past the cap spent its nonce")
	}
	if c := w.redis.Get(ctx, enrollredis.ACMEDeviceOrdersKey(d.id)).Val(); c != "5" {
		t.Fatalf("device order count = %q, want 5", c)
	}

	// Challenge and finalize refusals, on a fresh device.
	d2 := w.mac("C02REFUSED")
	kid2, orderURL, chal, cp, attKey := w.openChallenge(d2, key)
	orderID := orderURL[strings.LastIndex(orderURL, "/")+1:]
	ord, _ := w.store.GetACMEOrder(ctx, orderID)
	refuse := func(name, kid, url string, payload []byte, want int) {
		t.Helper()
		nonce := w.getNonce()
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: url, KID: kid}, payload)
		if rec := w.postJWS(url, j, ""); rec.Code != want {
			t.Errorf("%s = (%d, %s), want %d", name, rec.Code, rec.Body.String(), want)
		}
		if n := w.redis.Exists(ctx, enrollredis.ACMEUsedNonceKey(nonce)).Val(); n != 0 {
			t.Errorf("%s spent its nonce", name)
		}
	}
	refuse("finalize before the order is ready", kid2, orderURL+"/finalize", []byte(`{"csr":"AA"}`), 403)
	refuse("challenge with bad JSON", kid2, chal.URL, []byte(`{`), 400)
	refuse("challenge with a bad attObj", kid2, chal.URL, []byte(`{"attObj":"!!"}`), 400)
	refuse("challenge with bad CBOR", kid2, chal.URL, []byte(`{"attObj":"`+base64.RawURLEncoding.EncodeToString([]byte{0xff, 0x00})+`"}`), 400)
	if a, _ := w.store.GetACMEAuthz(ctx, ord.AuthzID); a.ChalStatus != "pending" {
		t.Fatalf("challenge after malformed responses = %s, want still pending", a.ChalStatus)
	}

	// A nonce a new-order spent, replayed on requests that would each change
	// state.
	orderPayload := []byte(`{"identifiers":[{"type":"permanent-identifier","value":"C02REFUSED"}]}`)
	spentN := w.getNonce()
	oj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: spentN, URL: d2.url("/new-order"), KID: kid2}, orderPayload)
	if rec := w.postJWS(d2.url("/new-order"), oj, ""); rec.Code != 201 {
		t.Fatalf("new-order = (%d, %s)", rec.Code, rec.Body.String())
	}
	orders := w.redis.Get(ctx, enrollredis.ACMEDeviceOrdersKey(d2.id)).Val()
	replayed := func(name, url string, payload []byte) {
		t.Helper()
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: spentN, URL: url, KID: kid2}, payload)
		if rec := w.postJWS(url, j, ""); rec.Code != 400 || problemType(t, rec) != ProblemBadNonce {
			t.Errorf("%s with a spent nonce = (%d, %s), want 400 badNonce", name, rec.Code, rec.Body.String())
		}
	}
	replayed("new-order", d2.url("/new-order"), orderPayload)
	replayed("challenge response", chal.URL, cp)
	if got := w.redis.Get(ctx, enrollredis.ACMEDeviceOrdersKey(d2.id)).Val(); got != orders {
		t.Fatalf("device order count after a replayed new-order = %s, want %s", got, orders)
	}
	if a, _ := w.store.GetACMEAuthz(ctx, ord.AuthzID); a.ChalStatus != "pending" {
		t.Fatalf("challenge after a replayed nonce = %s, want still pending", a.ChalStatus)
	}

	// The real response.
	cn := w.getNonce()
	cj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: cn, URL: chal.URL, KID: kid2}, cp)
	if rec := w.postJWS(chal.URL, cj, ""); rec.Code != 200 {
		t.Fatalf("challenge = (%d, %s)", rec.Code, rec.Body.String())
	}
	if n := w.redis.Exists(ctx, enrollredis.ACMEUsedNonceKey(cn)).Val(); n != 1 {
		t.Fatal("the validating challenge response spent no nonce")
	}

	refuse("finalize with a bad CSR", kid2, orderURL+"/finalize", []byte(`{"csr":"AA"}`), 400)
	refuse("finalize without a CSR", kid2, orderURL+"/finalize", []byte(`{}`), 400)
	permit, _ := enrolltoken.SignACMEPermit(w.acmeRing, d2.uuid, w.now.Add(10*time.Minute))
	csr, _ := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: d2.serial, OrganizationalUnit: []string{permit}},
	}, attKey)
	replayed("finalize", orderURL+"/finalize", []byte(`{"csr":"`+base64.RawURLEncoding.EncodeToString(csr)+`"}`))
	if o, _ := w.store.GetACMEOrder(ctx, orderID); o.Status != "ready" {
		t.Fatalf("order after refused finalizes = %s, want still ready", o.Status)
	}

	// An invalid challenge refuses a further response without spending.
	d3 := w.mac("C02INVALID")
	kid3, _, chal3, _, _ := w.openChallenge(d3, key)
	ej, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: chal3.URL, KID: kid3}, []byte(`{"error":"no attestation"}`))
	if rec := w.postJWS(chal3.URL, ej, ""); rec.Code != 403 {
		t.Fatalf("client-reported error = (%d, %s), want 403", rec.Code, rec.Body.String())
	}
	refuse("challenge that is not pending", kid3, chal3.URL, cp, 400)
}

// TestAReEnrollmentGetsAFreshOrderCap: the same serial, sealed again (a new
// device id), orders even though the first enrollment's cap is spent.
func TestAReEnrollmentGetsAFreshOrderCap(t *testing.T) {
	w := newTestACMEWorld(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	order := func(d *macDevice, kid string) int {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-order"), KID: kid},
			[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"C02AGAIN"}]}`))
		return w.postJWS(d.url("/new-order"), j, "").Code
	}
	first := w.mac("C02AGAIN")
	kid1 := w.registerAccount(first, key)
	for i := 0; i < w.handler.deps.MaxOrdersPerDevice; i++ {
		order(first, kid1)
	}
	if code := order(first, kid1); code != 429 {
		t.Fatalf("first enrollment past its cap = %d, want 429", code)
	}
	again := w.mac("C02AGAIN")
	if code := order(again, w.registerAccount(again, key)); code != 201 {
		t.Fatalf("the re-enrollment's first order = %d, want 201", code)
	}
}

// TestTheProfileDirectoryURLIsServed: the URL enrollctl puts in a Mac's
// profile (ACMEDirectoryFor over the configured directory URL, with a token
// signed by the shared ring) is a directory acmed serves, naming URLs under
// the same token.
func TestTheProfileDirectoryURLIsServed(t *testing.T) {
	now := time.Now().UTC()
	ring := testPathRing(t)
	h := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: nonceRing(t, ringKey("1", 1)), PathKeys: ring, Now: func() time.Time { return now }})
	dev, _ := enrolltoken.NewUUIDv7At(now)
	tok, _ := enrolltoken.SignACMEPath(ring, dev, "C02PROFILE", now.Add(enrolltoken.ACMEPathLifetime))
	dirURL := enrollctl.ACMEDirectoryFor(enrollctl.DefaultACMEDirectoryURL, tok)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, strings.TrimPrefix(dirURL, "https://ca.i10.tech"), nil))
	var dir map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &dir)
	base := strings.TrimSuffix(dirURL, "/directory")
	if rec.Code != 200 || dir["newOrder"] != base+"/new-order" || dir["newNonce"] != base+"/new-nonce" || dir["newAccount"] != base+"/new-account" {
		t.Fatalf("directory at %s = (%d, %v)", dirURL, rec.Code, dir)
	}
}
