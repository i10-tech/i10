package acmed

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrollredis/redistest"
)

func problemType(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var p Problem
	_ = json.Unmarshal(rec.Body.Bytes(), &p)
	return p.Type
}

// TestNewAccountAndAccountFetchWriteNothing: an account is its key. newAccount
// and POST-as-GET on the account answer through a Store every call of which
// fails the test.
func TestNewAccountAndAccountFetchWriteNothing(t *testing.T) {
	ring := nonceRing(t, ringKey("3", 3))
	h := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: ring, PathKeys: testPathRing(t)})
	base := "https://ca.i10.tech" + pathBase(t, testPathRing(t), "C02ACCT", time.Now())
	post := func(url string, body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, strings.TrimPrefix(url, "https://ca.i10.tech"), strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/jose+json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	nonce := func() string {
		n, err := h.issueNonce()
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	key, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	newAccount := func(payload string) *httptest.ResponseRecorder {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce(), URL: base + "/new-account", JWK: jwk}, []byte(payload))
		return post(base+"/new-account", j)
	}

	first := newAccount(`{"termsOfServiceAgreed":true,"contact":["mailto:x@example.com"]}`)
	kid := first.Header().Get("Location")
	if first.Code != 201 || !strings.HasPrefix(kid, base+"/acct/") || strings.Contains(first.Body.String(), "example.com") {
		t.Fatalf("new-account = (%d, %q, %s)", first.Code, kid, first.Body.String())
	}
	if len(kid) > maxAccountURLLen {
		t.Fatalf("a P-384 account URL is %d characters, over maxAccountURLLen %d", len(kid), maxAccountURLLen)
	}
	again := newAccount(`{"onlyReturnExisting":true}`)
	if again.Code != 200 || again.Header().Get("Location") != kid {
		t.Fatalf("onlyReturnExisting = (%d, %q), want 200 and the same URL %q", again.Code, again.Header().Get("Location"), kid)
	}

	j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce(), URL: kid, KID: kid}, nil)
	if rec := post(kid, j); rec.Code != 200 || rec.Header().Get("Location") != kid {
		t.Fatalf("POST-as-GET account = (%d, %s)", rec.Code, rec.Body.String())
	}
}

// statelessACME is a handler on a Store every call of which fails the test,
// with a helper to post under one path token.
type statelessACME struct {
	t    *testing.T
	h    *Handler
	base string // https://ca.i10.tech/acme/apple/d/<token>
}

func newStatelessACME(t *testing.T, serial string) *statelessACME {
	t.Helper()
	h := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: nonceRing(t, ringKey("3", 3)), PathKeys: testPathRing(t)})
	return &statelessACME{t: t, h: h, base: "https://ca.i10.tech" + pathBase(t, testPathRing(t), serial, time.Now())}
}

func (s *statelessACME) post(url string, key *ecdsa.PrivateKey, hdr ProtectedHeader, payload []byte) *httptest.ResponseRecorder {
	s.t.Helper()
	n, err := s.h.issueNonce()
	if err != nil {
		s.t.Fatal(err)
	}
	if hdr.Nonce == "" {
		hdr.Nonce = n
	}
	hdr.URL = url
	j, err := SignFlattenedJWS(key, hdr, payload)
	if err != nil {
		s.t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, strings.TrimPrefix(url, "https://ca.i10.tech"), strings.NewReader(string(j)))
	req.Header.Set("Content-Type", "application/jose+json")
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	return rec
}

// newAccount answers new-account for key with payload.
func (s *statelessACME) newAccount(key *ecdsa.PrivateKey, payload string) *httptest.ResponseRecorder {
	s.t.Helper()
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	return s.post(s.base+"/new-account", key, ProtectedHeader{JWK: jwk}, []byte(payload))
}

// assertACMEHeaders checks what RFC 8555 makes every answer to a POST carry:
// a Replay-Nonce (6.5), the directory as Link rel="index" (7.1), and the
// content type.
func (s *statelessACME) assertACMEHeaders(name string, rec *httptest.ResponseRecorder, contentType string) {
	s.t.Helper()
	if rec.Header().Get("Replay-Nonce") == "" {
		s.t.Errorf("%s: no Replay-Nonce", name)
	}
	if got := rec.Header().Get("Content-Type"); got != contentType {
		s.t.Errorf("%s: Content-Type = %q, want %q", name, got, contentType)
	}
	index := `<` + s.base + `/directory>;rel="index"`
	if links := rec.Header().Values("Link"); !slices.Contains(links, index) {
		s.t.Errorf("%s: Link = %v, want %s", name, links, index)
	}
}

// TestTheAccountObjectHasEveryRequiredField: new-account (201 and 200) and
// POST-as-GET on the account answer RFC 8555 7.1.2's object, with `orders`
// (required; macOS 27.3 fails "failed to establish account" without it) at
// <account URL>/orders and an empty `contact`, plus Location.
func TestTheAccountObjectHasEveryRequiredField(t *testing.T) {
	s := newStatelessACME(t, "C02SHAPE")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	created := s.newAccount(key, `{"termsOfServiceAgreed":true}`)
	kid := created.Header().Get("Location")
	if created.Code != 201 || kid == "" {
		t.Fatalf("new-account = (%d, %q, %s)", created.Code, kid, created.Body.String())
	}

	for name, rec := range map[string]*httptest.ResponseRecorder{
		"new-account":                    created,
		"new-account onlyReturnExisting": s.newAccount(key, `{"onlyReturnExisting":true}`),
		"POST-as-GET account":            s.post(kid, key, ProtectedHeader{KID: kid}, nil),
	} {
		s.assertACMEHeaders(name, rec, "application/json")
		if got := rec.Header().Get("Location"); got != kid {
			t.Errorf("%s: Location = %q, want %q", name, got, kid)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: body %s: %v", name, rec.Body.String(), err)
		}
		want := map[string]string{"status": `"valid"`, "contact": `[]`, "orders": `"` + kid + `/orders"`}
		for field, v := range want {
			if string(body[field]) != v {
				t.Errorf("%s: %s = %s, want %s (body %s)", name, field, body[field], v, rec.Body.String())
			}
		}
		if len(body) != len(want) {
			t.Errorf("%s: body %s does not have exactly the fields of %v", name, rec.Body.String(), want)
		}
	}
}

// TestTheOrdersListIsEmptyOwnedAndWritesNothing: POST-as-GET on
// <account URL>/orders answers {"orders":[]} to its own account, twice with
// one nonce (it spends none and writes nothing), and refuses another
// account's kid, a payload, and an account URL from another path token.
func TestTheOrdersListIsEmptyOwnedAndWritesNothing(t *testing.T) {
	s := newStatelessACME(t, "C02ORDERS")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid := s.newAccount(key, `{}`).Header().Get("Location")
	otherKID := s.newAccount(other, `{}`).Header().Get("Location")
	orders := kid + "/orders"

	nonce, _ := s.h.issueNonce()
	for try := 1; try <= 2; try++ {
		rec := s.post(orders, key, ProtectedHeader{KID: kid, Nonce: nonce}, nil)
		if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"orders":[]}` {
			t.Fatalf("orders list (try %d) = (%d, %s), want 200 {\"orders\":[]}", try, rec.Code, rec.Body.String())
		}
		s.assertACMEHeaders("orders list", rec, "application/json")
	}

	if rec := s.post(orders, other, ProtectedHeader{KID: otherKID}, nil); rec.Code != 401 || problemType(t, rec) != ProblemUnauthorized {
		t.Errorf("another account's kid = (%d, %s), want 401 unauthorized", rec.Code, rec.Body.String())
	}
	if rec := s.post(orders, key, ProtectedHeader{KID: kid}, []byte(`{}`)); rec.Code != 400 || problemType(t, rec) != ProblemMalformed {
		t.Errorf("a payload = (%d, %s), want 400 malformed", rec.Code, rec.Body.String())
	}
	elsewhere := newStatelessACME(t, "C02ORDERS")
	if rec := elsewhere.post(elsewhere.base+strings.TrimPrefix(orders, s.base), key, ProtectedHeader{KID: kid}, nil); rec.Code != 400 || problemType(t, rec) != ProblemAccountDoesNotExist {
		t.Errorf("under another path token = (%d, %s), want 400 accountDoesNotExist", rec.Code, rec.Body.String())
	}
}

// TestKidMustCarryAcmedsMAC: an account URL acmed did not issue, or issued
// under another path token, is accountDoesNotExist, before any Redis call.
func TestKidMustCarryAcmedsMAC(t *testing.T) {
	ring := nonceRing(t, ringKey("3", 3))
	h := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: ring, PathKeys: testPathRing(t)})
	other := NewHandler(HandlerDeps{Store: noRedis{t: t}, NonceKeys: nonceRing(t, ringKey("3", 4)), PathKeys: testPathRing(t)})
	path := pathBase(t, testPathRing(t), "C02MAC", time.Now())
	rt := route{base: "https://ca.i10.tech" + path}
	otherRT := route{base: "https://ca.i10.tech" + pathBase(t, testPathRing(t), "C02MAC", time.Now())}

	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := EncodePublicECJWK(&key.PublicKey)
	victim, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	victimJWK, _ := EncodePublicECJWK(&victim.PublicKey)
	good, _ := h.accountURL(rt, jwk)
	if a := h.parseAccountURL(rt, good); a == nil || a.Pub.X.Cmp(key.X) != 0 {
		t.Fatalf("acmed's own account URL does not parse: %v", a)
	}
	base := rt.url("/acct/")
	goodJWK, goodTag, _ := strings.Cut(strings.TrimPrefix(good, base), ".")
	tag, _ := base64.RawURLEncoding.DecodeString(goodTag)
	flipped := append([]byte{}, tag...)
	flipped[len(flipped)-1] ^= 1
	unknownKid := append([]byte{9}, tag[1:]...)
	byOtherKey, _ := other.accountURL(rt, jwk)
	underOtherToken, _ := h.accountURL(otherRT, jwk)

	for name, kid := range map[string]string{
		"a flipped MAC bit":         base + goodJWK + "." + base64.RawURLEncoding.EncodeToString(flipped),
		"an unknown key id":         base + goodJWK + "." + base64.RawURLEncoding.EncodeToString(unknownKid),
		"another key's MAC":         byOtherKey,
		"another JWK under my MAC":  base + base64.RawURLEncoding.EncodeToString(victimJWK) + "." + goodTag,
		"no MAC":                    base + goodJWK,
		"the old stored form":       rt.url("/account/abcdefgh12345678"),
		"another path token's URL":  underOtherToken,
		"the URL without any token": "https://ca.i10.tech/acme/apple/acct/" + goodJWK + "." + goodTag,
		"too long":                  good + strings.Repeat("A", maxAccountURLLen),
	} {
		nonce, _ := h.issueNonce()
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: rt.url("/new-order"), KID: kid},
			[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"C02MAC"}]}`))
		req := httptest.NewRequest(http.MethodPost, path+"/new-order", strings.NewReader(string(j)))
		req.Header.Set("Content-Type", "application/jose+json")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 400 || problemType(t, rec) != ProblemAccountDoesNotExist {
			t.Errorf("%s: = (%d, %s), want 400 accountDoesNotExist", name, rec.Code, rec.Body.String())
		}
	}
}

// TestRefusalsBeforeAuthorizationSpendNothing: a new-order for a serial the
// token does not cover, a malformed order, and a fetch of another account's
// order spend no nonce and write no key; the same nonce then works for an
// allowed request, and that spend outlives the nonce by nonceSpendMargin.
func TestRefusalsBeforeAuthorizationSpendNothing(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	serial := "C02GATE" + redistest.ID(t)[:6]
	d := w.mac(serial)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid := w.registerAccount(d, key)
	orderFor := func(nonce, value string) []byte {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: d.url("/new-order"), KID: kid},
			[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"`+value+`"}]}`))
		return j
	}
	nonce := w.getNonce()
	spentBefore := w.spy.spentCount()

	if rec := w.postJWS(d.url("/new-order"), orderFor(nonce, "C02OTHER"), ""); rec.Code != 403 || problemType(t, rec) != ProblemRejectedIdentifier {
		t.Fatalf("new-order for another serial = (%d, %s)", rec.Code, rec.Body.String())
	}
	bad, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: d.url("/new-order"), KID: kid}, []byte(`{"identifiers":[]}`))
	if rec := w.postJWS(d.url("/new-order"), bad, ""); rec.Code != 400 {
		t.Fatalf("malformed new-order = (%d, %s)", rec.Code, rec.Body.String())
	}

	// Another account's order, under the same token.
	owner, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ownerKID := w.registerAccount(d, owner)
	oj, _ := SignFlattenedJWS(owner, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-order"), KID: ownerKID},
		[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"`+serial+`"}]}`))
	orec := w.postJWS(d.url("/new-order"), oj, "")
	if orec.Code != 201 {
		t.Fatalf("owner's order = %d", orec.Code)
	}
	orderURL := orec.Header().Get("Location")
	spentBefore = w.spy.spentCount()
	steal, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: orderURL, KID: kid}, nil)
	if rec := w.postJWS(orderURL, steal, ""); rec.Code != 401 {
		t.Fatalf("another account's order = (%d, %s)", rec.Code, rec.Body.String())
	}

	if w.spy.spentCount() != spentBefore {
		t.Fatalf("a refused request spent a nonce: %v", w.spy.spent[spentBefore:])
	}
	if n, _ := w.redis.Exists(ctx, enrollredis.ACMEUsedNonceKey(nonce)).Result(); n != 0 {
		t.Fatal("a refused request spent its nonce")
	}

	// The unspent nonce now opens an order for the token's serial.
	if rec := w.postJWS(d.url("/new-order"), orderFor(nonce, serial), ""); rec.Code != 201 {
		t.Fatalf("the same nonce on an allowed request = (%d, %s)", rec.Code, rec.Body.String())
	}
	ttl := w.redis.TTL(ctx, enrollredis.ACMEUsedNonceKey(nonce)).Val()
	if ttl < nonceLifetime+nonceSpendMargin-5*time.Second || ttl > nonceLifetime+nonceSpendMargin {
		t.Fatalf("spent nonce TTL = %v, want the nonce's life plus %v", ttl, nonceSpendMargin)
	}
	if rec := w.postJWS(d.url("/new-order"), orderFor(nonce, serial), ""); rec.Code != 400 || problemType(t, rec) != ProblemBadNonce {
		t.Fatalf("replay on an allowed request = (%d, %s), want badNonce", rec.Code, rec.Body.String())
	}
}

// openChallenge opens an order under d for key and returns the account URL,
// the order URL and the challenge with its attestation payload.
func (w *testACMEWorld) openChallenge(d *macDevice, key *ecdsa.PrivateKey) (kid, orderURL string, chal struct{ Token, URL string }, payload []byte, attKey *ecdsa.PrivateKey) {
	w.t.Helper()
	kid = w.registerAccount(d, key)
	oj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: d.url("/new-order"), KID: kid},
		[]byte(`{"identifiers":[{"type":"permanent-identifier","value":"`+d.serial+`"}]}`))
	orec := w.postJWS(d.url("/new-order"), oj, "")
	if orec.Code != 201 {
		w.t.Fatalf("new-order = (%d, %s)", orec.Code, orec.Body.String())
	}
	var ob struct {
		Authorizations []string `json:"authorizations"`
	}
	_ = json.Unmarshal(orec.Body.Bytes(), &ob)
	aj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: ob.Authorizations[0], KID: kid}, nil)
	arec := w.postJWS(ob.Authorizations[0], aj, "")
	var ab struct {
		Challenges []struct{ Token, URL string } `json:"challenges"`
	}
	_ = json.Unmarshal(arec.Body.Bytes(), &ab)
	chal = ab.Challenges[0]
	nn := sha256.Sum256([]byte(chal.Token))
	leaf, attKey := w.makeAttestCert(w.appleInter, w.appleKey, d.serial, nn[:])
	payload, _ = json.Marshal(map[string]string{"attObj": base64.RawURLEncoding.EncodeToString(EncodeAppleAttestationCBOR([][]byte{leaf, w.appleInter.Raw}))})
	return kid, orec.Header().Get("Location"), chal, payload, attKey
}
