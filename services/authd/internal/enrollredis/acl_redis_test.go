package enrollredis

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// aclManifest is the manifest whose users.acl.rules the pod renders.
const aclManifest = "../../../../infra/k8s/i10/redis/enroll-redis.yaml"

// aclRules reads `<name> <rules...>` per user from the manifest's
// users.acl.rules block, exactly the text the init container renders.
func aclRules(t *testing.T) map[string][]string {
	t.Helper()
	raw, err := os.ReadFile(aclManifest)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`\n  users\.acl\.rules: \|\n((?:    .*\n)+)`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("users.acl.rules not found in " + aclManifest)
	}
	out := map[string][]string{}
	for _, line := range strings.Split(string(m[1]), "\n") {
		f := strings.Fields(line)
		if len(f) > 1 {
			out[f[0]] = f[1:]
		}
	}
	for _, u := range []string{"health", "api", "enrollctl", "cahookrelay", "acmed"} {
		if out[u] == nil {
			t.Fatalf("no ACL rules for %s", u)
		}
	}
	return out
}

// aclUsers loads every rendered user into the test Redis under a test-unique
// name and returns a client per user; the users are deleted at the end.
func aclUsers(t *testing.T) (map[string]*redis.Client, map[string]string, *redis.Client) {
	t.Helper()
	_, admin := openStore(t)
	ctx := context.Background()
	suffix := randHex(t)
	clients := map[string]*redis.Client{}
	users := map[string]string{}
	for name, rules := range aclRules(t) {
		user, pass := "acltest-"+name+"-"+suffix, "pw-"+suffix
		args := []any{"ACL", "SETUSER", user, "on", ">" + pass}
		for _, r := range rules {
			args = append(args, r)
		}
		if err := admin.Do(ctx, args...).Err(); err != nil {
			t.Fatalf("ACL SETUSER %s: %v", name, err)
		}
		t.Cleanup(func() { _ = admin.Do(context.Background(), "ACL", "DELUSER", user).Err() })
		c, err := NewClient(Config{URL: os.Getenv("ENROLL_TEST_REDIS_URL"), Username: user, Password: pass})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = c.Close() })
		clients[name] = c
		users[name] = user
	}
	return clients, users, admin
}

// allowed asks the server whether user may run cmd, without running it.
func allowed(t *testing.T, admin *redis.Client, user string, cmd ...any) bool {
	t.Helper()
	res, err := admin.Do(context.Background(), append([]any{"ACL", "DRYRUN", user}, cmd...)...).Text()
	if err != nil {
		t.Fatalf("ACL DRYRUN %s %v: %v", user, cmd, err)
	}
	return res == "OK"
}

func noPerm(err error) bool { return err != nil && strings.HasPrefix(err.Error(), "NOPERM") }

func mustOK(t *testing.T, what string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", what, err)
	}
}

// TestRenderedACLAllowsEachClientsCodeAndNothingDangerous runs each client's
// real store calls as its ACL user, then the dangerous list, which must all be
// NOPERM.
func TestRenderedACLAllowsEachClientsCodeAndNothingDangerous(t *testing.T) {
	clients, users, admin := aclUsers(t)
	ctx := context.Background()
	now := time.Now().UTC()
	as := func(name string) *RedisStore { return NewRedisStore(clients[name]) }
	// A fresh server forgets scripts; prove the NOSCRIPT path under the ACL too.
	mustOK(t, "SCRIPT FLUSH (admin)", admin.ScriptFlush(ctx).Err())

	uid, eid := "user_acl_"+randHex(t), testEID(t)
	serial := "C02ACL" + randHex(t)[:4]

	// api: create and cancel sessions (the same scripts enroll-redis.ts runs),
	// read the SCEP refusal, consume the notice stream.
	api := as("api")
	mustOK(t, "api CreateSession", api.CreateSession(ctx, openSession(uid, eid, now), now))
	if _, err := api.GetSCEPRefusal(ctx, eid); err != nil {
		t.Fatalf("api read refusal: %v", err)
	}
	group := "acltest-" + randHex(t)
	apiC := clients["api"]
	mustOK(t, "api XGROUP CREATE", apiC.Do(ctx, "XGROUP", "CREATE", NoticeStreamKey, group, "0", "MKSTREAM").Err())
	t.Cleanup(func() { _ = admin.XGroupDestroy(context.Background(), NoticeStreamKey, group).Err() })

	// enrollctl: attest, read the binding and refusal, mark sealing, seal,
	// enqueue a notice.
	ctl := as("enrollctl")
	mustOK(t, "enrollctl Ping", ctl.Ping(ctx))
	chal := "acl-chal-" + uid
	if att, err := ctl.AttestSession(ctx, attestInput(eid, serial, now, chal)); err != nil || att.Outcome != "scep" {
		t.Fatalf("enrollctl AttestSession = (%+v, %v)", att, err)
	}

	// cahookrelay: claim and authorize the challenge, record a refusal.
	relay := as("cahookrelay")
	mustOK(t, "relay Ping", relay.Ping(ctx))
	key := HashChallenge("acl-key-" + uid)
	if d, err := relay.SCEPClaim(ctx, chal, key, "acl-tx-"+uid, serial, now); err != nil || !d.Allow {
		t.Fatalf("relay SCEPClaim = (%+v, %v)", d, err)
	}
	if d, err := relay.SCEPAuthorize(ctx, key, serial, now); err != nil || !d.Allow {
		t.Fatalf("relay SCEPAuthorize = (%+v, %v)", d, err)
	}
	if _, err := relay.GetSCEPChallenge(ctx, HashChallenge(chal)); err != nil {
		t.Fatalf("relay GetSCEPChallenge: %v", err)
	}
	mustOK(t, "relay MarkSCEPRefused", relay.MarkSCEPRefused(ctx, testEID(t), "bad_template"))

	if kb, err := ctl.GetSCEPKeyBinding(ctx, key); err != nil || kb == nil {
		t.Fatalf("enrollctl GetSCEPKeyBinding = (%+v, %v)", kb, err)
	}
	if _, err := ctl.GetSCEPRefusal(ctx, eid); err != nil {
		t.Fatalf("enrollctl GetSCEPRefusal: %v", err)
	}
	sess, err := ctl.GetSession(ctx, eid)
	mustOK(t, "enrollctl GetSession", err)
	if _, err := ctl.GetSealedCache(ctx, eid); err != nil {
		t.Fatalf("enrollctl GetSealedCache: %v", err)
	}
	sess.Platform = "macos"
	if got, err := ctl.MarkSealing(ctx, eid, "attempt-"+uid); err != nil || !got {
		t.Fatalf("enrollctl MarkSealing = (%v, %v)", got, err)
	}
	if got, err := ctl.MarkSealing(ctx, eid, "another-"+uid); err != nil || got {
		t.Fatalf("enrollctl MarkSealing over a held marker = (%v, %v), want false", got, err)
	}
	mustOK(t, "enrollctl ClearSealing (another attempt's token)", ctl.ClearSealing(ctx, eid, "another-"+uid))
	if tok := admin.Get(ctx, SealingKey(eid)).Val(); tok != "attempt-"+uid {
		t.Fatalf("ClearSealing with another token removed the marker (now %q)", tok)
	}
	mustOK(t, "enrollctl ClearSealing", ctl.ClearSealing(ctx, eid, "attempt-"+uid))
	if n := admin.Exists(ctx, SealingKey(eid)).Val(); n != 0 {
		t.Fatal("ClearSealing with the holder's token left the marker")
	}
	mustOK(t, "enrollctl SealSession", ctl.SealSession(ctx, sess, SealedCache{KeySha256: key, DeviceID: "d", ProfileB64: "QQ=="}, now))
	mustOK(t, "enrollctl MarkSessionRefused", ctl.MarkSessionRefused(ctx, testEID(t), "x", now))
	mustOK(t, "enrollctl EnqueueNotice", ctl.EnqueueNotice(ctx, NoticeEvent{DeviceID: "acl-" + uid, Email: "a@b.test", Platform: "ios"}))

	// api again: read the notice and acknowledge it, reclaim, inspect pending.
	consumer := "c-" + randHex(t)
	streams, err := apiC.XReadGroup(ctx, &redis.XReadGroupArgs{Group: group, Consumer: consumer, Streams: []string{NoticeStreamKey, ">"}, Count: 1000}).Result()
	mustOK(t, "api XREADGROUP", err)
	if len(streams) == 0 || len(streams[0].Messages) == 0 {
		t.Fatal("api read no notice")
	}
	mustOK(t, "api XPENDING", apiC.Do(ctx, "XPENDING", NoticeStreamKey, group, "-", "+", 10).Err())
	mustOK(t, "api XAUTOCLAIM", apiC.Do(ctx, "XAUTOCLAIM", NoticeStreamKey, group, consumer, 0, "0-0", "COUNT", 10).Err())
	mustOK(t, "api XACK", apiC.XAck(ctx, NoticeStreamKey, group, streams[0].Messages[0].ID).Err())
	if res, err := api.CancelSession(ctx, eid, uid, now); err != nil || res != "already_sealed" {
		t.Fatalf("api CancelSession = (%q, %v)", res, err)
	}

	// acmed: an order (with its nonce), a challenge answer, every order move
	// (with a nonce and a cert). (Accounts are stateless: there is no account
	// key to write.)
	acme := as("acmed")
	mustOK(t, "acmed Ping", acme.Ping(ctx))
	thumb := "t-" + uid
	ord := ACMEOrder{ID: "o-" + uid, AccountID: thumb, DeviceID: "d-" + uid, Status: "pending", Expires: now.Add(time.Minute), Serial: serial, AuthzID: "a-" + uid}
	authz := ACMEAuthz{ID: ord.AuthzID, AccountID: thumb, DeviceID: ord.DeviceID, OrderID: ord.ID, Expires: ord.Expires, ChalID: "ch", ChalStatus: "pending"}
	if st, err := acme.CreateACMEOrder(ctx, ord, authz, "acl-order-"+uid, time.Minute, 5, now); err != nil || st != "OK" {
		t.Fatalf("acmed CreateACMEOrder = (%q, %v)", st, err)
	}
	if res, err := acme.AnswerACMEChallenge(ctx, ACMEChallengeAnswer{AuthzID: authz.ID, OrderID: ord.ID, ChalID: "ch", AccountID: thumb, DeviceID: ord.DeviceID, Nonce: "acl-chal-" + uid, NonceTTL: time.Minute, Valid: true, AttestedKeySha256: "k", AttestedX5CB64: []string{"QQ=="}}); err != nil || res.Outcome != ACMEOK {
		t.Fatalf("acmed AnswerACMEChallenge = (%+v, %v)", res, err)
	}
	mv := ACMEOrderMove{OrderID: ord.ID, AccountID: thumb, DeviceID: ord.DeviceID, From: "ready", To: "processing", Nonce: "acl-fin-" + uid, NonceTTL: time.Minute}
	if res, err := acme.MoveACMEOrder(ctx, mv); err != nil || res.Outcome != ACMEOK {
		t.Fatalf("acmed MoveACMEOrder (claim) = (%+v, %v)", res, err)
	}
	mv = ACMEOrderMove{OrderID: ord.ID, AccountID: thumb, DeviceID: ord.DeviceID, From: "processing", To: "valid", CertID: "c-" + uid, Cert: &ACMECert{AccountID: thumb, Expires: ord.Expires}, Now: now}
	if res, err := acme.MoveACMEOrder(ctx, mv); err != nil || res.Outcome != ACMEOK {
		t.Fatalf("acmed MoveACMEOrder (issue) = (%+v, %v)", res, err)
	}
	if _, err := acme.GetACMECert(ctx, "c-"+uid); err != nil {
		t.Fatalf("acmed GetACMECert: %v", err)
	}
	if _, err := acme.GetACMEOrder(ctx, ord.ID); err != nil {
		t.Fatalf("acmed GetACMEOrder: %v", err)
	}
	if _, err := acme.GetACMEAuthz(ctx, authz.ID); err != nil {
		t.Fatalf("acmed GetACMEAuthz: %v", err)
	}

	mustOK(t, "health PING", clients["health"].Ping(ctx).Err())

	// The dangerous list, for every user. ⚠ CHECKED WITH ACL DRYRUN, NEVER RUN:
	// a wrong rule would otherwise flush or shut down the test server.
	dangerous := [][]any{
		{"KEYS", "*"}, {"SCAN", "0"}, {"FLUSHALL"}, {"FLUSHDB"}, {"DEBUG", "SLEEP", "0"},
		{"CONFIG", "GET", "maxmemory"}, {"ACL", "LIST"}, {"ACL", "WHOAMI"}, {"MODULE", "LIST"},
		{"SCRIPT", "FLUSH"}, {"SCRIPT", "KILL"}, {"FUNCTION", "LIST"}, {"FUNCTION", "FLUSH"},
		{"EVAL", "return 1", "0"}, {"RESTORE", "enroll:acme:x", "0", "x"}, {"SORT", "enroll:acme:x"},
		{"MIGRATE", "127.0.0.1", "1", "enroll:acme:x", "0", "1"}, {"INFO"}, {"DUMP", "enroll:acme:x"},
		{"SHUTDOWN", "NOSAVE"}, {"MONITOR"}, {"CLIENT", "LIST"}, {"OBJECT", "ENCODING", "enroll:acme:x"},
	}
	// DRYRUN itself must be able to say yes, or the loop below proves nothing.
	if !allowed(t, admin, users["api"], "GET", SessionKey(eid)) || allowed(t, admin, users["cahookrelay"], "SET", SessionKey(eid), "x") {
		t.Fatal("ACL DRYRUN does not tell an allowed command from a refused one")
	}
	for name := range clients {
		for _, cmd := range dangerous {
			if allowed(t, admin, users[name], cmd...) {
				t.Errorf("%s may run %v", name, cmd)
			}
		}
	}
	if err := clients["health"].Get(ctx, SessionKey(eid)).Err(); !noPerm(err) {
		t.Errorf("health read a session (err %v)", err)
	}
}

// TestCahookrelayCannotWriteSessions is the hijack boundary: the relay may read
// a session and nothing more, directly or through any script.
func TestCahookrelayCannotWriteSessions(t *testing.T) {
	clients, _, _ := aclUsers(t)
	ctx := context.Background()
	now := time.Now().UTC()
	relay := clients["cahookrelay"]
	uid, eid := "user_aclw_"+randHex(t), testEID(t)
	mustOK(t, "api CreateSession", NewRedisStore(clients["api"]).CreateSession(ctx, openSession(uid, eid, now), now))

	if err := relay.Get(ctx, SessionKey(eid)).Err(); err != nil {
		t.Fatalf("relay cannot read a session: %v", err)
	}
	for name, err := range map[string]error{
		"SET":  relay.Set(ctx, SessionKey(eid), `{"status":"attested"}`, time.Minute).Err(),
		"DEL":  relay.Del(ctx, SessionKey(eid)).Err(),
		"SCAN": relay.Scan(ctx, 0, "enroll:sess:*", 100).Err(),
		"cancel_session.lua": func() error {
			_, err := scriptCancelSession.run(ctx, relay, []string{SessionKey(eid), UserLiveKey(uid)}, eid, uid, 1, 60)
			return err
		}(),
		"mark_session_refused.lua": func() error {
			_, err := scriptMarkSessionRefused.run(ctx, relay, []string{SessionKey(eid)}, "x", 1, 60)
			return err
		}(),
		"read sealed":  relay.Get(ctx, SealedKey(eid)).Err(),
		"write notice": relay.XAdd(ctx, &redis.XAddArgs{Stream: NoticeStreamKey, Values: []any{"a", "b"}}).Err(),
		"read acme":    relay.Get(ctx, ACMEOrderKey("x")).Err(),
	} {
		if !noPerm(err) {
			t.Errorf("relay %s: err %v, want NOPERM", name, err)
		}
	}
	if sess, _ := NewRedisStore(clients["enrollctl"]).GetSession(ctx, eid); sess == nil || sess.Status != "open" {
		t.Fatalf("session after the relay's attempts = %+v", sess)
	}

	// The other users' key boundaries.
	for name, err := range map[string]error{
		"acmed reads a session":      clients["acmed"].Get(ctx, SessionKey(eid)).Err(),
		"api reads a key binding":    clients["api"].Get(ctx, SCEPKeyKey("x")).Err(),
		"api writes a SCEP refusal":  clients["api"].Set(ctx, SCEPRefusalKey(eid), "x", time.Minute).Err(),
		"api reads the sealed cache": clients["api"].Get(ctx, SealedKey(eid)).Err(),
	} {
		if !noPerm(err) {
			t.Errorf("%s: err %v, want NOPERM", name, err)
		}
	}
}
