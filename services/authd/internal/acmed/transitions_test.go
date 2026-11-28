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
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/i10-tech/i10/services/authd/internal/enrollredis"
	"github.com/i10-tech/i10/services/authd/internal/enrolltoken"
)

// readyOrder opens an order under d for key, answers its challenge, and
// returns the account URL, the order id and URL, and a finalize payload
// with a good CSR.
func (w *testACMEWorld) readyOrder(d *macDevice, key *ecdsa.PrivateKey) (kid, orderID, orderURL string, finPayload []byte) {
	w.t.Helper()
	kid, orderURL, chal, cp, attKey := w.openChallenge(d, key)
	cj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: chal.URL, KID: kid}, cp)
	if rec := w.postJWS(chal.URL, cj, ""); rec.Code != 200 {
		w.t.Fatalf("challenge = (%d, %s)", rec.Code, rec.Body.String())
	}
	return kid, orderURL[strings.LastIndex(orderURL, "/")+1:], orderURL, w.finalizePayload(d, attKey, "")
}

// finalizePayload is a finalize body for d's key with its permit (or ou).
func (w *testACMEWorld) finalizePayload(d *macDevice, attKey *ecdsa.PrivateKey, ou string) []byte {
	w.t.Helper()
	if ou == "" {
		ou, _ = enrolltoken.SignACMEPermit(w.acmeRing, d.uuid, w.now.Add(10*time.Minute))
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{
		Subject: pkix.Name{CommonName: d.serial, OrganizationalUnit: []string{ou}},
	}, attKey)
	if err != nil {
		w.t.Fatal(err)
	}
	p, _ := json.Marshal(map[string]string{"csr": base64.RawURLEncoding.EncodeToString(csr)})
	return p
}

// certsOf counts the certificate keys in Redis that belong to device id.
func (w *testACMEWorld) certsOf(deviceID string) int {
	w.t.Helper()
	ctx := context.Background()
	n := 0
	iter := w.redis.Scan(ctx, 0, enrollredis.ACMECertKeyPrefix+"*", 1000).Iterator()
	for iter.Next(ctx) {
		var c enrollredis.ACMECert
		if raw, err := w.redis.Get(ctx, iter.Val()).Bytes(); err == nil && json.Unmarshal(raw, &c) == nil && c.DeviceID == deviceID {
			n++
		}
	}
	if err := iter.Err(); err != nil {
		w.t.Fatal(err)
	}
	return n
}

// spentAmong counts the nonces whose used-nonce key exists.
func (w *testACMEWorld) spentAmong(nonces []string) int {
	w.t.Helper()
	n := 0
	for _, nc := range nonces {
		n += int(w.redis.Exists(context.Background(), enrollredis.ACMEUsedNonceKey(nc)).Val())
	}
	return n
}

// burst posts one request per nonce at once, each signed by key under kid.
func (w *testACMEWorld) burst(key *ecdsa.PrivateKey, kid, url string, payload []byte, n int) ([]*httptest.ResponseRecorder, []string) {
	w.t.Helper()
	nonces := make([]string, n)
	bodies := make([][]byte, n)
	for i := range nonces {
		nonces[i] = w.getNonce()
		bodies[i], _ = SignFlattenedJWS(key, ProtectedHeader{Nonce: nonces[i], URL: url, KID: kid}, payload)
	}
	recs := make([]*httptest.ResponseRecorder, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range bodies {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			recs[i] = w.postJWS(url, bodies[i], "")
		}(i)
	}
	close(start)
	wg.Wait()
	return recs, nonces
}

// TestConcurrentFinalizesIssueOnce: N finalizes of one ready order, each with
// its own nonce, at once. Exactly one calls enrollctl, one certificate is
// written, one nonce is spent, and the order ends valid with that
// certificate; the rest are orderNotReady.
func TestConcurrentFinalizesIssueOnce(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	d := w.mac("C02BURSTFIN")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid, orderID, orderURL, fp := w.readyOrder(d, key)
	w.finalizer.delay = 200 * time.Millisecond // hold the claimant inside enrollctl

	const n = 8
	recs, nonces := w.burst(key, kid, orderURL+"/finalize", fp, n)
	ok := 0
	for i, rec := range recs {
		switch {
		case rec.Code == 200:
			ok++
		case rec.Code == 403 && problemType(t, rec) == ProblemOrderNotReady:
		default:
			t.Errorf("finalize %d = (%d, %s), want 200 or 403 orderNotReady", i, rec.Code, rec.Body.String())
		}
	}
	if ok != 1 || w.finalizer.count() != 1 {
		t.Fatalf("finalizes = %d issued, %d enrollctl calls; want 1 and 1", ok, w.finalizer.count())
	}
	if spent := w.spentAmong(nonces); spent != 1 {
		t.Fatalf("spent nonces = %d, want 1", spent)
	}
	if c := w.certsOf(d.id); c != 1 {
		t.Fatalf("certificate keys for the device = %d, want 1", c)
	}
	o, _ := w.store.GetACMEOrder(ctx, orderID)
	if o == nil || o.Status != "valid" || o.CertID == "" {
		t.Fatalf("order = %+v, want valid with a certificate", o)
	}
	if c, _ := w.store.GetACMECert(ctx, o.CertID); c == nil || c.DeviceID != d.id {
		t.Fatalf("the order's certificate = %+v", c)
	}
}

// TestARefusedFinalizeCannotUndoAValidOrder: while one finalize is inside
// enrollctl, a second (whose permit enrollctl would refuse) is orderNotReady
// with Retry-After, calls nothing and spends nothing; the first then makes
// the order valid, and the refused one sent again leaves it valid with its
// certificate.
func TestARefusedFinalizeCannotUndoAValidOrder(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	d := w.mac("C02RACEFIN")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid, orderURL, chal, cp, attKey := w.openChallenge(d, key)
	cj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: chal.URL, KID: kid}, cp)
	if rec := w.postJWS(chal.URL, cj, ""); rec.Code != 200 {
		t.Fatalf("challenge = (%d, %s)", rec.Code, rec.Body.String())
	}
	orderID := orderURL[strings.LastIndex(orderURL, "/")+1:]
	good := w.finalizePayload(d, attKey, "")
	forged := w.finalizePayload(d, attKey, strings.Repeat("A", 50))
	fin := func(payload []byte, nonce string) *httptest.ResponseRecorder {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: nonce, URL: orderURL + "/finalize", KID: kid}, payload)
		return w.postJWS(orderURL+"/finalize", j, "")
	}

	w.finalizer.gateFirst = make(chan struct{})
	w.finalizer.entered = make(chan struct{}, 1)
	goodRec := make(chan *httptest.ResponseRecorder, 1)
	goodNonce := w.getNonce()
	go func() { goodRec <- fin(good, goodNonce) }()
	<-w.finalizer.entered

	if o, _ := w.store.GetACMEOrder(ctx, orderID); o == nil || o.Status != "processing" {
		t.Fatalf("order while enrollctl runs = %+v, want processing", o)
	}
	pollJ, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: orderURL, KID: kid}, nil)
	if rec := w.postJWS(orderURL, pollJ, ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"status":"processing"`) || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("order poll while processing = (%d, %s, Retry-After %q)", rec.Code, rec.Body.String(), rec.Header().Get("Retry-After"))
	}
	forgedNonce := w.getNonce()
	rec := fin(forged, forgedNonce)
	if rec.Code != 403 || problemType(t, rec) != ProblemOrderNotReady || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("finalize while processing = (%d, %s, Retry-After %q), want 403 orderNotReady with Retry-After", rec.Code, rec.Body.String(), rec.Header().Get("Retry-After"))
	}
	if w.finalizer.count() != 1 || w.spentAmong([]string{forgedNonce}) != 0 {
		t.Fatalf("a finalize of a processing order called enrollctl (%d calls) or spent its nonce", w.finalizer.count())
	}

	close(w.finalizer.gateFirst)
	if r := <-goodRec; r.Code != 200 {
		t.Fatalf("the claimant's finalize = (%d, %s)", r.Code, r.Body.String())
	}
	if rec := fin(forged, w.getNonce()); rec.Code != 403 || problemType(t, rec) != ProblemOrderNotReady {
		t.Fatalf("a refused finalize after valid = (%d, %s), want 403 orderNotReady", rec.Code, rec.Body.String())
	}
	o, _ := w.store.GetACMEOrder(ctx, orderID)
	if o == nil || o.Status != "valid" || o.CertID == "" || w.finalizer.count() != 1 {
		t.Fatalf("order = %+v after %d enrollctl calls, want valid with its certificate after 1", o, w.finalizer.count())
	}
}

// TestAnUnavailableUpstreamReturnsTheOrderToReady: enrollctl unavailable is
// 503, spends the claim's nonce, and leaves the order ready; the next
// finalize issues.
func TestAnUnavailableUpstreamReturnsTheOrderToReady(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	d := w.mac("C02UPSTREAM")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid, orderID, orderURL, fp := w.readyOrder(d, key)
	fin := func() *httptest.ResponseRecorder {
		j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: orderURL + "/finalize", KID: kid}, fp)
		return w.postJWS(orderURL+"/finalize", j, "")
	}
	w.finalizer.fail = true
	if rec := fin(); rec.Code != 503 {
		t.Fatalf("finalize with enrollctl down = (%d, %s), want 503", rec.Code, rec.Body.String())
	}
	if o, _ := w.store.GetACMEOrder(ctx, orderID); o == nil || o.Status != "ready" || o.CertID != "" {
		t.Fatalf("order after enrollctl was down = %+v, want ready", o)
	}
	w.finalizer.fail = false
	if rec := fin(); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"status":"valid"`) {
		t.Fatalf("the next finalize = (%d, %s), want valid", rec.Code, rec.Body.String())
	}
}

// TestASlowFinalizeStillCompletesTheOrder: an enrollctl call that takes
// longer than the completion timeout does not spend it. The completion gets
// its own timeout once enrollctl answers, so an issued certificate makes the
// order valid, an unavailable upstream returns it to ready, and a refusal
// marks it invalid.
func TestASlowFinalizeStillCompletesTheOrder(t *testing.T) {
	const complete = 100 * time.Millisecond
	for _, tc := range []struct {
		name     string
		forged   bool // a permit enrollctl refuses
		fail     bool // enrollctl unavailable
		wantCode int
		want     string
	}{
		{name: "issued", wantCode: 200, want: "valid"},
		{name: "upstream unavailable", fail: true, wantCode: 503, want: "ready"},
		{name: "refused", forged: true, wantCode: 403, want: "invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newTestACMEWorld(t)
			w.handler.completeTimeout = complete
			d := w.mac("C02SLOWFIN")
			key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			kid, orderURL, chal, cp, attKey := w.openChallenge(d, key)
			cj, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: chal.URL, KID: kid}, cp)
			if rec := w.postJWS(chal.URL, cj, ""); rec.Code != 200 {
				t.Fatalf("challenge = (%d, %s)", rec.Code, rec.Body.String())
			}
			payload := w.finalizePayload(d, attKey, "")
			if tc.forged {
				payload = w.finalizePayload(d, attKey, strings.Repeat("A", 50))
			}
			w.finalizer.delay, w.finalizer.fail = complete+50*time.Millisecond, tc.fail

			j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: w.getNonce(), URL: orderURL + "/finalize", KID: kid}, payload)
			if rec := w.postJWS(orderURL+"/finalize", j, ""); rec.Code != tc.wantCode {
				t.Fatalf("finalize = (%d, %s), want %d", rec.Code, rec.Body.String(), tc.wantCode)
			}
			o, _ := w.store.GetACMEOrder(context.Background(), orderURL[strings.LastIndex(orderURL, "/")+1:])
			if o == nil || o.Status != tc.want || (o.CertID != "") != (tc.want == "valid") {
				t.Fatalf("order = %+v, want %s", o, tc.want)
			}
			if tc.want == "valid" {
				if c, _ := w.store.GetACMECert(context.Background(), o.CertID); c == nil || c.DeviceID != d.id {
					t.Fatalf("the order's certificate = %+v", c)
				}
			}
		})
	}
}

// TestConcurrentChallengeAnswersMoveOnce: N answers to one pending challenge,
// each with its own nonce, at once: all are answered 200 valid, exactly one
// nonce is spent, and the authz is valid and the order ready.
func TestConcurrentChallengeAnswersMoveOnce(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	d := w.mac("C02BURSTCHAL")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid, orderURL, chal, cp, _ := w.openChallenge(d, key)
	orderID := orderURL[strings.LastIndex(orderURL, "/")+1:]

	const n = 8
	recs, nonces := w.burst(key, kid, chal.URL, cp, n)
	for i, rec := range recs {
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"status":"valid"`) {
			t.Errorf("answer %d = (%d, %s), want 200 valid", i, rec.Code, rec.Body.String())
		}
	}
	if spent := w.spentAmong(nonces); spent != 1 {
		t.Fatalf("spent nonces = %d, want 1", spent)
	}
	o, _ := w.store.GetACMEOrder(ctx, orderID)
	a, _ := w.store.GetACMEAuthz(ctx, o.AuthzID)
	if o.Status != "ready" || a.Status != "valid" || a.ChalStatus != "valid" || a.AttestedKeySha256 == "" || len(a.AttestedX5CB64) != 2 {
		t.Fatalf("after the burst: order %s, authz %+v; want ready and valid with the attested key", o.Status, a)
	}
}

// TestAValidChallengeFinishesAPendingOrderOnce: an authz valid with its order
// still pending (a state an older writer could leave): a burst of answers
// that all read the order pending moves it to ready once and spends one
// nonce, and every answer is 200; an answer after that spends nothing.
func TestAValidChallengeFinishesAPendingOrderOnce(t *testing.T) {
	w := newTestACMEWorld(t)
	ctx := context.Background()
	d := w.mac("C02HALFSAVED")
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid, orderURL, chal, cp, _ := w.openChallenge(d, key)
	orderID := orderURL[strings.LastIndex(orderURL, "/")+1:]
	o, _ := w.store.GetACMEOrder(ctx, orderID)
	a, _ := w.store.GetACMEAuthz(ctx, o.AuthzID)
	a.Status, a.ChalStatus, a.AttestedKeySha256, a.AttestedX5CB64 = "valid", "valid", "00", []string{"AA=="}
	w.put(enrollredis.ACMEAuthzKey(a.ID), a, time.Minute)

	// All 8 read the order pending before any moves it.
	w.spy.orderReads = newReadBarrier(8)
	recs, nonces := w.burst(key, kid, chal.URL, cp, 8)
	w.spy.orderReads = nil
	for i, rec := range recs {
		if rec.Code != 200 {
			t.Errorf("answer %d = (%d, %s), want 200", i, rec.Code, rec.Body.String())
		}
	}
	if spent := w.spentAmong(nonces); spent != 1 {
		t.Fatalf("spent nonces = %d, want 1", spent)
	}
	if o, _ := w.store.GetACMEOrder(ctx, orderID); o.Status != "ready" {
		t.Fatalf("order = %s, want ready", o.Status)
	}
	after := w.getNonce()
	j, _ := SignFlattenedJWS(key, ProtectedHeader{Nonce: after, URL: chal.URL, KID: kid}, cp)
	if rec := w.postJWS(chal.URL, j, ""); rec.Code != 200 || w.spentAmong([]string{after}) != 0 {
		t.Fatalf("an answer once the order is ready = %d, or it spent its nonce", rec.Code)
	}
}
