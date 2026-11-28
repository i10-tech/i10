package enrollredis

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Redis-gated: the Lua scripts against a real Redis, skipped without one.
//
//	ENROLL_TEST_REDIS_URL=redis://127.0.0.1:6379 go test -race ./internal/enrollredis/
func openStore(t *testing.T) (*RedisStore, *redis.Client) {
	t.Helper()
	u := os.Getenv("ENROLL_TEST_REDIS_URL")
	if u == "" {
		if os.Getenv("ENROLL_TEST_REDIS_REQUIRED") != "" {
			t.Fatal("ENROLL_TEST_REDIS_URL is required (ENROLL_TEST_REDIS_REQUIRED is set)")
		}
		t.Skip("ENROLL_TEST_REDIS_URL is not set")
	}
	c, err := NewClient(Config{URL: u})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return NewRedisStore(c), c
}

func randHex(t *testing.T) string {
	t.Helper()
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b[:])
}

func testEID(t *testing.T) string {
	h := randHex(t)
	return "019ab100-" + h[0:4] + "-7" + h[4:7] + "-8" + h[7:10] + "-" + h[10:16] + "000000"
}

func openSession(uid, eid string, now time.Time) Session {
	return Session{
		ID: eid, ClerkUserID: uid, Email: "ada@acme.test", ExpectedEpoch: 1, CreatedBy: uid,
		Status: "open", CreatedAtMs: now.UnixMilli(),
		ExpiresAtMs: now.Add(15 * time.Minute).UnixMilli(), UpdatedAtMs: now.UnixMilli(),
	}
}

func attestInput(eid, serial string, now time.Time, chal string) AttestInput {
	return AttestInput{
		EID: eid, Now: now, Serial: serial, UDIDSha256: HashChallenge("udid-1"),
		AppleSignerSha256: HashChallenge("signer-1"), Product: "Mac15,6", OSVersion: "24D70",
		DeviceName: "Ada's Mac", Platform: "macos", NewChalHash: HashChallenge(chal),
	}
}

func TestEnrollmentLifecycleOnRedis(t *testing.T) {
	store, _ := openStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	now := time.Now().UTC().Truncate(time.Second)
	uid := "user_redis_test_" + randHex(t)
	eid1, eid2 := testEID(t), testEID(t)
	serial := "C02MAC" + randHex(t)[:6]

	// 1. A second create cancels the first (M5).
	if err := store.CreateSession(ctx, openSession(uid, eid1, now), now); err != nil {
		t.Fatalf("CreateSession s1: %v", err)
	}
	if err := store.CreateSession(ctx, openSession(uid, eid2, now), now.Add(time.Second)); err != nil {
		t.Fatalf("CreateSession s2: %v", err)
	}
	if got1, err := store.GetSession(ctx, eid1); err != nil || got1 == nil || got1.Status != "cancelled" {
		t.Fatalf("s1 after M5 replacement = (%+v, %v), want cancelled", got1, err)
	}

	// 2. First attest binds serial/udid/signer; another serial is refused (H2).
	chal1 := "chal-1-" + uid
	if att, err := store.AttestSession(ctx, attestInput(eid2, serial, now.Add(2*time.Second), chal1)); err != nil || att.Outcome != "scep" || att.Serial != serial {
		t.Fatalf("AttestSession 1 = (%+v, %v)", att, err)
	}
	if att, err := store.AttestSession(ctx, attestInput(eid2, "C02OTHER", now.Add(3*time.Second), "chal-bad-"+uid)); err != nil || att.Reason != "device_mismatch" {
		t.Fatalf("H2 mismatch = (%+v, %v), want device_mismatch", att, err)
	}

	// 3. A claim on challenge 1, then an attest retry: challenge 1, its key
	// binding and its transaction are all retired.
	key1, tx1 := HashChallenge("scep-key-1-"+uid), "tx-1-"+uid
	if d, err := store.SCEPClaim(ctx, chal1, key1, tx1, serial, now.Add(3*time.Second)); err != nil || !d.Allow {
		t.Fatalf("SCEPClaim on challenge 1 = (%+v, %v)", d, err)
	}
	chal2 := "chal-2-" + uid
	if att, err := store.AttestSession(ctx, attestInput(eid2, serial, now.Add(4*time.Second), chal2)); err != nil || att.Outcome != "scep" {
		t.Fatalf("AttestSession retry = (%+v, %v)", att, err)
	}
	if old, _ := store.GetSCEPChallenge(ctx, HashChallenge(chal1)); old != nil {
		t.Fatal("challenge 1 survived the attest retry")
	}
	if kb, _ := store.GetSCEPKeyBinding(ctx, key1); kb != nil {
		t.Fatal("challenge 1's key binding survived the attest retry")
	}

	// 4. Claim, identical retry, authorize. The binding carries the plaintext.
	keyA, txA := HashChallenge("scep-key-A-"+uid), "tx-A-"+uid
	if d, err := store.SCEPClaim(ctx, chal2, keyA, txA, serial, now.Add(5*time.Second)); err != nil || !d.Allow {
		t.Fatalf("SCEPClaim = (%+v, %v)", d, err)
	}
	if d, err := store.SCEPClaim(ctx, chal2, keyA, txA, serial, now.Add(6*time.Second)); err != nil || d.Outcome != "allowed_retry" {
		t.Fatalf("SCEPClaim retry = (%+v, %v)", d, err)
	}
	if d, err := store.SCEPAuthorize(ctx, keyA, serial, now.Add(7*time.Second)); err != nil || !d.Allow {
		t.Fatalf("SCEPAuthorize = (%+v, %v)", d, err)
	}
	kb, err := store.GetSCEPKeyBinding(ctx, keyA)
	if err != nil || kb == nil || kb.Challenge != chal2 || kb.ChalHash != HashChallenge(chal2) || kb.EID != eid2 || kb.Status != "authorized" {
		t.Fatalf("key binding = (%+v, %v)", kb, err)
	}
	// The relay never wrote the session.
	if got, _ := store.GetSession(ctx, eid2); got.Status != "attested" || got.SCEPChalHash != HashChallenge(chal2) {
		t.Fatalf("session after SCEP = %+v", got)
	}

	// 5. Another key for the same challenge: refused, and recorded as the
	// session's SCEP refusal (not in the session).
	if d, err := store.SCEPClaim(ctx, chal2, HashChallenge("other-key"), "tx-B", serial, now.Add(7*time.Second)); err != nil || d.Allow || d.Outcome != "scep_key_conflict" {
		t.Fatalf("second key = (%+v, %v), want scep_key_conflict", d, err)
	}
	if code, err := store.GetSCEPRefusal(ctx, eid2); err != nil || code != "scep_key_conflict" {
		t.Fatalf("SCEP refusal = (%q, %v)", code, err)
	}

	// 6. Seal, retry cache, cancel answers already_sealed.
	got2, _ := store.GetSession(ctx, eid2)
	devID := testEID(t)
	if err := store.SealSession(ctx, got2, SealedCache{KeySha256: keyA, DeviceID: devID, ProfileB64: "QUFB"}, now.Add(8*time.Second)); err != nil {
		t.Fatalf("SealSession: %v", err)
	}
	if cached, err := store.GetSealedCache(ctx, eid2); err != nil || cached == nil || cached.DeviceID != devID {
		t.Fatalf("GetSealedCache = (%+v, %v)", cached, err)
	}
	if res, err := store.CancelSession(ctx, eid2, uid, now.Add(9*time.Second)); err != nil || res != "already_sealed" {
		t.Fatalf("CancelSession sealed = (%q, %v), want already_sealed", res, err)
	}
	if err := store.EnqueueNotice(ctx, NoticeEvent{DeviceID: devID, Email: "ada@acme.test", Platform: "macos", Model: "Mac15,6", SerialLast4: "C001"}); err != nil {
		t.Fatalf("EnqueueNotice: %v", err)
	}

	// 7. A SCEP refusal moves an attested session to refused at the next attest.
	uid3, eid3 := "user_redis_test_"+randHex(t), testEID(t)
	if err := store.CreateSession(ctx, openSession(uid3, eid3, now), now); err != nil {
		t.Fatal(err)
	}
	if att, _ := store.AttestSession(ctx, attestInput(eid3, serial, now, "chal-3-"+uid3)); att.Outcome != "scep" {
		t.Fatalf("attest s3 = %+v", att)
	}
	if err := store.MarkSCEPRefused(ctx, eid3, "bad_template"); err != nil {
		t.Fatal(err)
	}
	if att, err := store.AttestSession(ctx, attestInput(eid3, serial, now.Add(time.Second), "chal-4-"+uid3)); err != nil || att.Reason != "bad_template" {
		t.Fatalf("attest after SCEP refusal = (%+v, %v), want bad_template", att, err)
	}
	if got3, _ := store.GetSession(ctx, eid3); got3.Status != "refused" || got3.Refusal != "bad_template" {
		t.Fatalf("session after SCEP refusal = %+v", got3)
	}
}

// TestAttestRetriesWhenAClaimLandsBetweenReadAndScript is the M4 race: attest
// read the session and the old challenge, then a claim bound a key to that
// challenge before the script ran. The script must answer retry rather than
// retire keys it was not told about, and the next attempt retires the binding.
func TestAttestRetriesWhenAClaimLandsBetweenReadAndScript(t *testing.T) {
	store, _ := openStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	uid, eid := "user_redis_race_"+randHex(t), testEID(t)
	serial := "C02RACE" + randHex(t)[:4]
	if err := store.CreateSession(ctx, openSession(uid, eid, now), now); err != nil {
		t.Fatal(err)
	}
	chal1 := "race-chal-1-" + uid
	if att, _ := store.AttestSession(ctx, attestInput(eid, serial, now, chal1)); att.Outcome != "scep" {
		t.Fatalf("attest 1 = %+v", att)
	}

	// What attest reads before the script...
	sess, _ := store.GetSession(ctx, eid)
	old, _ := store.GetSCEPChallenge(ctx, sess.SCEPChalHash)
	// ...then the claim lands.
	key := HashChallenge("race-key-" + uid)
	if d, err := store.SCEPClaim(ctx, chal1, key, "race-tx", serial, now); err != nil || !d.Allow {
		t.Fatalf("claim = (%+v, %v)", d, err)
	}
	res, err := store.attestOnce(ctx, attestInput(eid, serial, now.Add(time.Second), "race-chal-2-"+uid), sess, old)
	if err != nil || res.Outcome != "retry" {
		t.Fatalf("attest with a stale read = (%+v, %v), want retry", res, err)
	}
	if kb, _ := store.GetSCEPKeyBinding(ctx, key); kb == nil {
		t.Fatal("a retried attest must not have changed anything")
	}

	// The real AttestSession re-reads and retires the binding.
	if att, err := store.AttestSession(ctx, attestInput(eid, serial, now.Add(time.Second), "race-chal-2-"+uid)); err != nil || att.Outcome != "scep" {
		t.Fatalf("attest 2 = (%+v, %v)", att, err)
	}
	if kb, _ := store.GetSCEPKeyBinding(ctx, key); kb != nil {
		t.Fatal("the old challenge's binding survived")
	}
}

// TestSessionJSONMatchesTheAPIFixtures pins the shared record both ways:
// testdata/session-open.json is what the API writes (apps/api asserts its
// create produces it) and must read here; testdata/session-sealed.json is what
// Go writes and the API's view must read (apps/api asserts that).
func TestSessionJSONMatchesTheAPIFixtures(t *testing.T) {
	raw, err := os.ReadFile("testdata/session-open.json")
	if err != nil {
		t.Fatal(err)
	}
	var open Session
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&open); err != nil {
		t.Fatalf("the API's session JSON does not decode strictly: %v", err)
	}
	if open.ID != "019ac4c2-8f00-7a31-9c55-6a7d1e2f3b4c" || open.ClerkUserID != "user_fixture" ||
		open.Email != "ada@acme.test" || open.TenantID == nil || *open.TenantID != "5d7e9c1a-3b2f-4a6d-8e0c-1f2a3b4c5d6e" ||
		open.ExpectedEpoch != 4 || open.CreatedBy != "user_fixture" || open.Status != "open" ||
		open.CreatedAtMs != 1764300000000 || open.ExpiresAtMs != 1764300900000 || open.UpdatedAtMs != 1764300000000 {
		t.Fatalf("open fixture decoded as %+v", open)
	}

	tenant := "5d7e9c1a-3b2f-4a6d-8e0c-1f2a3b4c5d6e"
	sealed := Session{
		ID: open.ID, ClerkUserID: "user_fixture", Email: "ada@acme.test", TenantID: &tenant,
		ExpectedEpoch: 4, CreatedBy: "user_fixture", Status: "sealed", Serial: "C02FIXTURE",
		Product: "Mac15,6", OSVersion: "24D70", DeviceName: "Ada's Mac",
		UDIDSha256:        "1111111111111111111111111111111111111111111111111111111111111111",
		AppleSignerSha256: "2222222222222222222222222222222222222222222222222222222222222222",
		Platform:          "macos", DeviceID: "019ac4c3-0000-7000-8000-00000000d001",
		SCEPChalHash: "3333333333333333333333333333333333333333333333333333333333333333",
		CreatedAtMs:  1764300000000, ExpiresAtMs: 1764300600000, UpdatedAtMs: 1764300300000,
	}
	got, _ := json.Marshal(sealed)
	want, err := os.ReadFile("testdata/session-sealed.json")
	if err != nil {
		t.Fatal(err)
	}
	var gotV, wantV any
	_ = json.Unmarshal(got, &gotV)
	if err := json.Unmarshal(want, &wantV); err != nil {
		t.Fatal(err)
	}
	gotN, _ := json.Marshal(gotV)
	wantN, _ := json.Marshal(wantV)
	if string(gotN) != string(wantN) {
		t.Fatalf("Go writes\n%s\nthe fixture says\n%s", gotN, wantN)
	}
}

func TestACMEStateLivesOnlyAsLongAsItsObject(t *testing.T) {
	store, c := openStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	id := randHex(t)

	thumb := "thumb-" + id
	serial := "C02ACME" + id[:4]
	dev := "dev-" + id
	ord := ACMEOrder{ID: "ord-" + id, AccountID: thumb, DeviceID: dev, Status: "pending", Expires: now.Add(10 * time.Minute), Serial: serial, AuthzID: "authz-" + id}
	authz := ACMEAuthz{ID: ord.AuthzID, AccountID: thumb, DeviceID: dev, OrderID: ord.ID, Status: "pending", Expires: ord.Expires, Serial: serial, ChalID: "c", ChalToken: "t", ChalStatus: "pending"}
	if st, err := store.CreateACMEOrder(ctx, ord, authz, "order-nonce-"+id, time.Minute, 1, now); err != nil || st != "OK" {
		t.Fatalf("CreateACMEOrder = (%q, %v)", st, err)
	}
	if ttl := c.TTL(ctx, ACMEUsedNonceKey("order-nonce-"+id)).Val(); ttl <= 0 || ttl > time.Minute {
		t.Fatalf("the order's nonce key TTL = %v, want at most 1m", ttl)
	}
	// The order's nonce is spent: the same nonce again is bad_nonce and
	// writes no order.
	ordR := ord
	ordR.ID = "ordR-" + id
	ordR.DeviceID = "dev-replay-" + id
	if st, _ := store.CreateACMEOrder(ctx, ordR, authz, "order-nonce-"+id, time.Minute, 5, now); st != "bad_nonce" {
		t.Fatalf("a replayed order nonce = %q, want bad_nonce", st)
	}
	for _, k := range []string{ACMEOrderKey(ordR.ID), ACMEDeviceOrdersKey(ordR.DeviceID)} {
		if n := c.Exists(ctx, k).Val(); n != 0 {
			t.Fatalf("a bad_nonce order wrote %s", k)
		}
	}
	// The cap is per device: another account (key) is refused too, and the
	// refusal spends no nonce.
	ord2 := ord
	ord2.ID = "ord2-" + id
	ord2.AccountID = "another-thumb-" + id
	if st, _ := store.CreateACMEOrder(ctx, ord2, authz, "capped-nonce-"+id, time.Minute, 1, now); st != "order_cap_exceeded" {
		t.Fatalf("second order for the device = %q, want order_cap_exceeded", st)
	}
	if n := c.Exists(ctx, ACMEUsedNonceKey("capped-nonce-"+id), ACMEOrderKey(ord2.ID)).Val(); n != 0 {
		t.Fatalf("a capped order wrote %d keys", n)
	}
	// The same serial under another device (a re-enrollment) has its own cap.
	ord3 := ord
	ord3.ID = "ord3-" + id
	ord3.DeviceID = "dev-reenrolled-" + id
	if st, _ := store.CreateACMEOrder(ctx, ord3, authz, "reenroll-nonce-"+id, time.Minute, 1, now); st != "OK" {
		t.Fatalf("the same serial under a new device = %q, want OK", st)
	}

	// A move five minutes later keeps the order's own remaining lifetime, and
	// its certificate lives exactly as long.
	later := now.Add(5 * time.Minute)
	owner := ACMEOrderMove{OrderID: ord.ID, AccountID: thumb, DeviceID: dev}
	move := func(m ACMEOrderMove, from, to string) ACMEResult {
		t.Helper()
		m.From, m.To = from, to
		res, err := store.MoveACMEOrder(ctx, m)
		if err != nil {
			t.Fatalf("MoveACMEOrder %s -> %s: %v", from, to, err)
		}
		return res
	}
	if res := move(owner, "pending", "ready"); res.Outcome != ACMEOK || res.Status != "ready" {
		t.Fatalf("pending -> ready = %+v", res)
	}
	if ttl := c.TTL(ctx, ACMEOrderKey(ord.ID)).Val(); ttl > 10*time.Minute || ttl < 9*time.Minute {
		t.Fatalf("order TTL after a move = %v, want its own (about 10m)", ttl)
	}
	// Another account or device is not_found and writes nothing; a wrong from
	// status is a conflict that spends nothing.
	stranger := owner
	stranger.AccountID = "another-" + id
	if res := move(stranger, "ready", "processing"); res.Outcome != ACMENotFound {
		t.Fatalf("another account's move = %+v, want not_found", res)
	}
	otherDev := owner
	otherDev.DeviceID = "another-dev-" + id
	if res := move(otherDev, "ready", "processing"); res.Outcome != ACMENotFound {
		t.Fatalf("another device's move = %+v, want not_found", res)
	}
	claim := owner
	claim.Nonce, claim.NonceTTL = "claim-"+id, time.Minute
	if res := move(claim, "pending", "processing"); res.Outcome != ACMEConflict || res.Status != "ready" {
		t.Fatalf("a move from the wrong status = %+v, want conflict at ready", res)
	}
	if n := c.Exists(ctx, ACMEUsedNonceKey(claim.Nonce)).Val(); n != 0 {
		t.Fatal("a conflicting move spent its nonce")
	}
	// The claim spends; the same nonce again is bad_nonce.
	if res := move(claim, "ready", "processing"); res.Outcome != ACMEOK || res.Status != "processing" {
		t.Fatalf("claim = %+v", res)
	}
	back := move(owner, "processing", "ready")
	if back.Outcome != ACMEOK {
		t.Fatalf("processing -> ready = %+v", back)
	}
	if res := move(claim, "ready", "processing"); res.Outcome != ACMEBadNonce {
		t.Fatalf("a claim with a spent nonce = %+v, want bad_nonce", res)
	}
	if o, _ := store.GetACMEOrder(ctx, ord.ID); o.Status != "ready" {
		t.Fatalf("order after a bad_nonce claim = %s, want ready", o.Status)
	}
	move(owner, "ready", "processing")
	issued := owner
	issued.CertID, issued.Now = "cert-"+id, later
	issued.Cert = &ACMECert{AccountID: thumb, DeviceID: dev, PEM: "-----BEGIN CERTIFICATE-----", Expires: ord.Expires}
	if res := move(issued, "processing", "valid"); res.Outcome != ACMEOK || res.Status != "valid" {
		t.Fatalf("processing -> valid = %+v", res)
	}
	if ttl := c.TTL(ctx, ACMECertKey("cert-"+id)).Val(); ttl > 5*time.Minute+time.Second || ttl < 4*time.Minute {
		t.Fatalf("cert TTL = %v, want the order's remaining life (about 5m)", ttl)
	}
	got, err := store.GetACMECert(ctx, "cert-"+id)
	if err != nil || got == nil || got.AccountID != thumb {
		t.Fatalf("GetACMECert = (%+v, %v)", got, err)
	}
	if o, _ := store.GetACMEOrder(ctx, ord.ID); o.Status != "valid" || o.CertID != "cert-"+id || !o.Expires.Equal(ord.Expires) || o.Serial != serial {
		t.Fatalf("order after issue = %+v", o)
	}
	refused := owner
	refused.ErrorType = "x"
	if res := move(refused, "processing", "invalid"); res.Outcome != ACMEConflict || res.Status != "valid" {
		t.Fatalf("a refusal of a valid order = %+v, want conflict at valid", res)
	}
	expired := issued
	expired.Now = now.Add(11 * time.Minute)
	if _, err := store.MoveACMEOrder(ctx, expired); !errors.Is(err, ErrExpired) {
		t.Fatalf("writing an expired cert = %v, want ErrExpired", err)
	}
}

// TestAChallengeAnswerMovesTheAuthzAndOrderOnce: a valid answer moves the
// authz valid and the order ready and spends its nonce; a second answer is
// not_pending and spends nothing; an invalid answer to another pending
// challenge makes both invalid; nothing outlives its object.
func TestAChallengeAnswerMovesTheAuthzAndOrderOnce(t *testing.T) {
	store, c := openStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	id := randHex(t)
	open := func(suffix string) (ACMEOrder, ACMEAuthz) {
		t.Helper()
		ord := ACMEOrder{ID: "ord-" + suffix + id, AccountID: "thumb-" + id, DeviceID: "dev-" + suffix + id, Status: "pending", Expires: now.Add(10 * time.Minute), Serial: "C02ANS", AuthzID: "authz-" + suffix + id}
		authz := ACMEAuthz{ID: ord.AuthzID, AccountID: ord.AccountID, DeviceID: ord.DeviceID, OrderID: ord.ID, Status: "pending", Expires: ord.Expires, Serial: "C02ANS", ChalID: "chal-" + suffix, ChalToken: "t", ChalStatus: "pending"}
		if st, err := store.CreateACMEOrder(ctx, ord, authz, "open-"+suffix+id, time.Minute, 5, now); err != nil || st != "OK" {
			t.Fatalf("CreateACMEOrder = (%q, %v)", st, err)
		}
		return ord, authz
	}
	answer := func(authz ACMEAuthz, nonce string, valid bool) ACMEResult {
		t.Helper()
		a := ACMEChallengeAnswer{AuthzID: authz.ID, OrderID: authz.OrderID, ChalID: authz.ChalID, AccountID: authz.AccountID, DeviceID: authz.DeviceID, Nonce: nonce, NonceTTL: time.Minute, Valid: valid}
		if valid {
			a.AttestedKeySha256, a.AttestedX5CB64, a.ValidatedAt = "abcd", []string{"QQ==", "Qg/+"}, now.Format(time.RFC3339)
		} else {
			a.ErrorType, a.ErrorMsg = "urn:x", "bad"
		}
		res, err := store.AnswerACMEChallenge(ctx, a)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}

	ord, authz := open("v")
	wrong := authz
	wrong.ChalID = "another"
	if res := answer(wrong, "wrong-"+id, true); res.Outcome != ACMENotFound || c.Exists(ctx, ACMEUsedNonceKey("wrong-"+id)).Val() != 0 {
		t.Fatalf("an answer naming another challenge = %+v, or it spent", res)
	}
	if res := answer(authz, "first-"+id, true); res.Outcome != ACMEOK || res.Status != "valid" {
		t.Fatalf("a valid answer = %+v", res)
	}
	if res := answer(authz, "second-"+id, true); res.Outcome != ACMENotPending || res.Status != "valid" || c.Exists(ctx, ACMEUsedNonceKey("second-"+id)).Val() != 0 {
		t.Fatalf("a second answer = %+v, want not_pending and no spend", res)
	}
	a, _ := store.GetACMEAuthz(ctx, authz.ID)
	o, _ := store.GetACMEOrder(ctx, ord.ID)
	if a.Status != "valid" || a.ChalStatus != "valid" || a.AttestedKeySha256 != "abcd" || len(a.AttestedX5CB64) != 2 || a.AttestedX5CB64[1] != "Qg/+" || !a.Expires.Equal(authz.Expires) || o.Status != "ready" {
		t.Fatalf("after a valid answer: authz %+v, order %s", a, o.Status)
	}
	for _, k := range []string{ACMEAuthzKey(authz.ID), ACMEOrderKey(ord.ID)} {
		if ttl := c.TTL(ctx, k).Val(); ttl <= 0 || ttl > 10*time.Minute {
			t.Fatalf("%s TTL = %v, want its own", k, ttl)
		}
	}

	ord2, authz2 := open("i")
	if res := answer(authz2, "first-"+id, true); res.Outcome != ACMEBadNonce {
		t.Fatalf("an answer with a spent nonce = %+v, want bad_nonce", res)
	}
	if res := answer(authz2, "inv-"+id, false); res.Outcome != ACMEOK || res.Status != "invalid" {
		t.Fatalf("an invalid answer = %+v", res)
	}
	a2, _ := store.GetACMEAuthz(ctx, authz2.ID)
	o2, _ := store.GetACMEOrder(ctx, ord2.ID)
	if a2.Status != "invalid" || a2.ErrorType != "urn:x" || o2.Status != "invalid" || o2.ErrorType != "urn:x" {
		t.Fatalf("after an invalid answer: authz %+v, order %+v", a2, o2)
	}
}

// TestARecordedSCEPRefusalIsTerminal: after the relay records a refusal, a
// later claim of the same challenge with the right serial and key is refused,
// and so is authorizing a key it claimed before the refusal.
func TestARecordedSCEPRefusalIsTerminal(t *testing.T) {
	store, _ := openStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	serial := "C02TERM" + randHex(t)[:6]

	setup := func() (eid, chal string) {
		uid := "user_term_" + randHex(t)
		eid = testEID(t)
		if err := store.CreateSession(ctx, openSession(uid, eid, now), now); err != nil {
			t.Fatal(err)
		}
		chal = "chal-term-" + uid
		if att, err := store.AttestSession(ctx, attestInput(eid, serial, now, chal)); err != nil || att.Outcome != "scep" {
			t.Fatalf("attest = (%+v, %v)", att, err)
		}
		return eid, chal
	}

	// A wrong serial is refused and recorded; the right one afterwards is too.
	_, chal := setup()
	key := HashChallenge("term-key-" + randHex(t))
	if d, _ := store.SCEPClaim(ctx, chal, key, "tx-term-1-"+serial, "C02WRONG", now); d.Allow || d.Outcome != "serial_mismatch" {
		t.Fatalf("wrong serial = %+v, want serial_mismatch", d)
	}
	if d, err := store.SCEPClaim(ctx, chal, key, "tx-term-1-"+serial, serial, now); err != nil || d.Allow || d.Outcome != "serial_mismatch" {
		t.Fatalf("correct claim after a refusal = (%+v, %v), want the recorded serial_mismatch", d, err)
	}

	// A key claimed before the refusal cannot be authorized after it.
	_, chal = setup()
	keyA := HashChallenge("term-key-a-" + randHex(t))
	if d, err := store.SCEPClaim(ctx, chal, keyA, "tx-term-a-"+serial, serial, now); err != nil || !d.Allow {
		t.Fatalf("claim = (%+v, %v)", d, err)
	}
	if d, _ := store.SCEPClaim(ctx, chal, HashChallenge("term-key-b-"+randHex(t)), "tx-term-b-"+serial, serial, now); d.Outcome != "scep_key_conflict" {
		t.Fatalf("second key = %+v, want scep_key_conflict", d)
	}
	if d, err := store.SCEPAuthorize(ctx, keyA, serial, now); err != nil || d.Allow || d.Outcome != "scep_key_conflict" {
		t.Fatalf("authorize after a refusal = (%+v, %v), want the recorded scep_key_conflict", d, err)
	}
}

// TestSealSessionReportsAMissingSessionAndClearsARefusal: sealing a session
// whose key is gone is an error and writes nothing; sealing a session a
// concurrent refusal marked leaves it sealed with no refusal.
func TestSealSessionReportsAMissingSessionAndClearsARefusal(t *testing.T) {
	store, c := openStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	cache := SealedCache{KeySha256: "k", DeviceID: "d-" + randHex(t), ProfileB64: "QQ=="}

	gone := openSession("user_gone_"+randHex(t), testEID(t), now)
	if err := store.SealSession(ctx, &gone, cache, now); err == nil {
		t.Fatal("SealSession of a missing session returned nil")
	}
	if n := c.Exists(ctx, SealedKey(gone.ID)).Val(); n != 0 {
		t.Fatal("SealSession of a missing session wrote the sealed cache")
	}

	sess := openSession("user_refused_"+randHex(t), testEID(t), now)
	if err := store.CreateSession(ctx, sess, now); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkSessionRefused(ctx, sess.ID, "enrollment_conflict", now); err != nil {
		t.Fatal(err)
	}
	if err := store.SealSession(ctx, &sess, cache, now); err != nil {
		t.Fatalf("SealSession: %v", err)
	}
	got, err := store.GetSession(ctx, sess.ID)
	if err != nil || got == nil || got.Status != "sealed" || got.Refusal != "" {
		t.Fatalf("sealed session = (%+v, %v), want sealed with no refusal", got, err)
	}
}
