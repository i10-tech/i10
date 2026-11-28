package enrollredis

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// Session is the JSON state persisted in `enroll:sess:<eid>`.
//
// ⚠ ITS JSON IS SHARED WITH apps/api/src/mail-devices/enroll-redis.ts
// (RedisSessionRecord); testdata/session-*.json pin both directions.
//
// ⚠ ONLY THE API (create, cancel) AND enrollctl (attest, refuse, seal) WRITE
// IT. cahookrelay may only read it, so nothing the SCEP hooks parse can change
// a session's challenge, serial or person.
type Session struct {
	ID                string  `json:"id"`
	ClerkUserID       string  `json:"clerk_user_id"`
	Email             string  `json:"email"`
	TenantID          *string `json:"tenant_id,omitempty"`
	ExpectedEpoch     int64   `json:"expected_epoch"`
	CreatedBy         string  `json:"created_by"`
	Status            string  `json:"status"` // open | attested | sealed | refused | expired | cancelled
	Refusal           string  `json:"refusal,omitempty"`
	Serial            string  `json:"serial,omitempty"`
	Product           string  `json:"product,omitempty"`
	OSVersion         string  `json:"os_version,omitempty"`
	DeviceName        string  `json:"device_name,omitempty"`
	UDIDSha256        string  `json:"udid_sha256,omitempty"`
	AppleSignerSha256 string  `json:"apple_signer_sha256,omitempty"`
	Platform          string  `json:"platform,omitempty"` // ios | ipados | macos
	DeviceID          string  `json:"device_id,omitempty"`
	SCEPChalHash      string  `json:"scep_chal_hash,omitempty"`
	CreatedAtMs       int64   `json:"created_at_ms"`
	ExpiresAtMs       int64   `json:"expires_at_ms"`
	UpdatedAtMs       int64   `json:"updated_at_ms"`
}

// SCEPChallenge is persisted in `enroll:scep:chal:<chal_hash>`.
type SCEPChallenge struct {
	EID         string `json:"eid"`
	ClerkUserID string `json:"clerk_user_id"`
	Serial      string `json:"serial"`
	ChalHash    string `json:"chal_hash"`
	KeySha256   string `json:"key_sha256,omitempty"`
	TxID        string `json:"tx_id,omitempty"`
	Status      string `json:"status"` // open | challenged | authorized
	ExpiresAtMs int64  `json:"expires_at_ms"`
}

// SCEPKeyBinding is persisted in `enroll:scep:key:<key_hash>`.
//
// ⚠ Challenge IS THE PLAINTEXT step-ca SENT cahookrelay. enrollctl's finish
// mints only when sha256(Challenge) is the session's current scep_chal_hash, so
// the relay can vouch for a challenge only by having received it.
type SCEPKeyBinding struct {
	EID         string `json:"eid"`
	ClerkUserID string `json:"clerk_user_id"`
	Serial      string `json:"serial"`
	ChalHash    string `json:"chal_hash"`
	Challenge   string `json:"challenge"`
	KeySha256   string `json:"key_sha256"`
	TxID        string `json:"tx_id"`
	Status      string `json:"status"` // challenged | authorized
	ExpiresAtMs int64  `json:"expires_at_ms"`
}

// SealedCache is persisted in `enroll:sealed:<eid>` (TTL 120s, M2 retry cache).
type SealedCache struct {
	KeySha256  string `json:"key_sha256"`
	DeviceID   string `json:"device_id"`
	ProfileB64 string `json:"profile_b64"`
}

// AttestInput is passed to Store.AttestSession.
type AttestInput struct {
	EID               string
	Now               time.Time
	Serial            string
	UDIDSha256        string
	AppleSignerSha256 string
	Product           string
	OSVersion         string
	DeviceName        string
	Platform          string
	NewChalHash       string
	RefusalCode       string
}

// AttestResult is returned by Store.AttestSession.
type AttestResult struct {
	Outcome     string `json:"outcome"` // scep | refused
	Reason      string `json:"reason,omitempty"`
	Serial      string `json:"serial,omitempty"`
	ExpiresAtMs int64  `json:"expires_at_ms,omitempty"`
}

// SCEPDecision is returned by SCEPClaim and SCEPAuthorize.
type SCEPDecision struct {
	Allow   bool   `json:"allow"`
	Outcome string `json:"outcome"`
}

// NoticeEvent is written to the `enroll:notice` Redis stream after Phase 4 seal.
type NoticeEvent struct {
	DeviceID    string
	Email       string
	Platform    string
	Model       string
	SerialLast4 string
}

// ACMEOrder is persisted in `enroll:acme:order:<id>`.
//
// AccountID, here and in ACMEAuthz and ACMECert, is the owning account key's
// RFC 7638 thumbprint: an ACME account is its key and is stored nowhere.
// DeviceID is the device the request's path token names: a request under
// another device's token is refused, whatever its account.
type ACMEOrder struct {
	ID        string    `json:"id"`
	AccountID string    `json:"account_id"`
	DeviceID  string    `json:"device_id"`
	Status    string    `json:"status"` // pending | ready | processing | valid | invalid
	Expires   time.Time `json:"expires"`
	Serial    string    `json:"serial"`
	AuthzID   string    `json:"authz_id"`
	CertID    string    `json:"cert_id,omitempty"`
	ErrorType string    `json:"error_type,omitempty"`
	ErrorMsg  string    `json:"error_msg,omitempty"`
}

// ACMEAuthz is persisted in `enroll:acme:authz:<id>`.
type ACMEAuthz struct {
	ID                string    `json:"id"`
	AccountID         string    `json:"account_id"`
	DeviceID          string    `json:"device_id"`
	OrderID           string    `json:"order_id"`
	Status            string    `json:"status"` // pending | valid | invalid
	Expires           time.Time `json:"expires"`
	Serial            string    `json:"serial"`
	ChalID            string    `json:"chal_id"`
	ChalToken         string    `json:"chal_token"`
	ChalStatus        string    `json:"chal_status"` // pending | valid | invalid
	AttestedKeySha256 string    `json:"attested_key_sha256,omitempty"`
	AttestedX5CB64    []string  `json:"attested_x5c_b64,omitempty"`
	ValidatedAt       string    `json:"validated_at,omitempty"`
	ErrorType         string    `json:"error_type,omitempty"`
	ErrorMsg          string    `json:"error_msg,omitempty"`
}

// ACMECert is persisted in `enroll:acme:cert:<id>`: only its account may fetch it.
type ACMECert struct {
	AccountID string    `json:"account_id"`
	DeviceID  string    `json:"device_id"`
	PEM       string    `json:"pem"`
	Expires   time.Time `json:"expires"`
}

// The outcomes of MoveACMEOrder and AnswerACMEChallenge. A refusal writes
// nothing, not even the used-nonce key.
const (
	ACMEOK           = "OK"
	ACMENotFound     = "not_found"     // absent, or another account's or device's
	ACMEConflict     = "conflict"      // the order is not in the From status
	ACMENotPending   = "not_pending"   // the challenge was already answered
	ACMEOrderMissing = "order_missing" // the authz's order is gone
	ACMEBadNonce     = "bad_nonce"     // the nonce was spent before
)

// ACMEResult is a transition's outcome and the object's status after it (the
// order's for MoveACMEOrder, the challenge's for AnswerACMEChallenge).
type ACMEResult struct {
	Outcome string
	Status  string
}

// ACMEOrderMove is one compare-and-set of an order's status, under its owner
// (account thumbprint and device id).
type ACMEOrderMove struct {
	OrderID, AccountID, DeviceID string
	From, To                     string
	// Nonce is spent (SET NX) only once every check has passed; "" spends
	// nothing.
	Nonce    string
	NonceTTL time.Duration
	// Cert, when set, is written under CertID in the same script, for the
	// order's remaining lifetime, and the order records CertID.
	CertID string
	Cert   *ACMECert
	// ErrorType, when set, records the order's error.
	ErrorType, ErrorMsg string
	// Now is when the cert's remaining lifetime is counted from.
	Now time.Time
}

// ACMEChallengeAnswer is the verified answer to a pending challenge: valid
// with the attested key and chain, or invalid with the error.
type ACMEChallengeAnswer struct {
	AuthzID, OrderID, ChalID string
	AccountID, DeviceID      string
	Nonce                    string
	NonceTTL                 time.Duration
	Valid                    bool
	AttestedKeySha256        string
	AttestedX5CB64           []string
	ValidatedAt              string
	ErrorType, ErrorMsg      string
}

// ErrExpired is returned when an ACME object is written after its own expiry.
var ErrExpired = errors.New("enrollredis: object already expired")

// Store is the Redis coordination seam shared by enrollctl, cahookrelay, acmed,
// and enrollload. Each binary uses its own subset under its own ACL user.
type Store interface {
	Ping(ctx context.Context) error

	// Enrollment sessions (the API's copy lives in enroll-redis.ts; enrollctl).
	CreateSession(ctx context.Context, s Session, now time.Time) error
	GetSession(ctx context.Context, eid string) (*Session, error)
	CancelSession(ctx context.Context, eid, uid string, now time.Time) (string, error)
	AttestSession(ctx context.Context, in AttestInput) (AttestResult, error)
	MarkSessionRefused(ctx context.Context, eid, code string, now time.Time) error
	SealSession(ctx context.Context, sess *Session, cache SealedCache, now time.Time) error
	GetSealedCache(ctx context.Context, eid string) (*SealedCache, error)
	// MarkSealing records token as the finish attempt about to mint eid
	// (SET NX, SealingTTLSec) and reports whether it acquired the marker:
	// false when another attempt's marker is there.
	MarkSealing(ctx context.Context, eid, token string) (bool, error)
	// ClearSealing deletes eid's marker only if it still holds token.
	ClearSealing(ctx context.Context, eid, token string) error
	EnqueueNotice(ctx context.Context, ev NoticeEvent) error

	// SCEP (cahookrelay writes; enrollctl reads at finish).
	GetSCEPChallenge(ctx context.Context, chalHashHex string) (*SCEPChallenge, error)
	GetSCEPKeyBinding(ctx context.Context, keyHashHex string) (*SCEPKeyBinding, error)
	SCEPClaim(ctx context.Context, challenge, keyHashHex, txID, csrCN string, now time.Time) (SCEPDecision, error)
	SCEPAuthorize(ctx context.Context, keyHashHex, csrCN string, now time.Time) (SCEPDecision, error)
	MarkSCEPRefused(ctx context.Context, eid, code string) error
	GetSCEPRefusal(ctx context.Context, eid string) (string, error)

	// ACME state (acmed). Every write keeps the object's REMAINING lifetime
	// (its own Expires), never a fresh full TTL.
	//
	// ⚠ acmed CALLS NOTHING HERE WITHOUT A VERIFIED PATH TOKEN, which only a
	// sealed Mac's profile carries. Accounts are stateless (no key at all),
	// read-only requests spend no nonce, and a state change spends its nonce
	// inside the one script that makes it, after every check that can refuse
	// it. Each transition is one script, so of N concurrent requests on one
	// object exactly one changes it.
	//
	// CreateACMEOrder checks the device's order cap, spends the nonce and
	// stores the order and authz in one script: "OK", "order_cap_exceeded" or
	// "bad_nonce"; a refusal writes nothing.
	CreateACMEOrder(ctx context.Context, order ACMEOrder, authz ACMEAuthz, nonce string, nonceTTL time.Duration, maxOrdersPerDevice int, now time.Time) (string, error)
	GetACMEOrder(ctx context.Context, orderID string) (*ACMEOrder, error)
	// MoveACMEOrder moves an order from m.From to m.To (acme_move_order.lua).
	MoveACMEOrder(ctx context.Context, m ACMEOrderMove) (ACMEResult, error)
	GetACMEAuthz(ctx context.Context, authzID string) (*ACMEAuthz, error)
	// AnswerACMEChallenge records the verified answer to a pending challenge
	// and moves its order (acme_answer_challenge.lua).
	AnswerACMEChallenge(ctx context.Context, a ACMEChallengeAnswer) (ACMEResult, error)
	GetACMECert(ctx context.Context, certID string) (*ACMECert, error)
}

// HashTxID computes the deterministic SHA-256 hex key suffix for a SCEP transaction id.
func HashTxID(txID string) string {
	sum := sha256.Sum256([]byte(txID))
	return hex.EncodeToString(sum[:])
}

// HashChallenge is the hex SHA-256 a SCEP challenge is filed under.
func HashChallenge(challenge string) string {
	sum := sha256.Sum256([]byte(challenge))
	return hex.EncodeToString(sum[:])
}

// RedisStore implements Store on go-redis.
type RedisStore struct {
	client *redis.Client
}

// NewRedisStore wraps a client from NewClient.
func NewRedisStore(client *redis.Client) *RedisStore {
	return &RedisStore{client: client}
}

func (s *RedisStore) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

// getJSON reads one JSON key into v; (false, nil) when the key is absent.
func (s *RedisStore) getJSON(ctx context.Context, key string, v any) (bool, error) {
	raw, err := s.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return false, fmt.Errorf("enrollredis: decode %s: %w", strings.SplitN(key, ":", 3)[1], err)
	}
	return true, nil
}

func (s *RedisStore) getString(ctx context.Context, key string) (string, error) {
	v, err := s.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	return v, err
}

func msArg(t time.Time) string { return strconv.FormatInt(t.UTC().UnixMilli(), 10) }

func (s *RedisStore) CreateSession(ctx context.Context, sess Session, now time.Time) error {
	raw, err := json.Marshal(sess)
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 3; attempt++ {
		prevEID, err := s.getString(ctx, UserLiveKey(sess.ClerkUserID))
		if err != nil {
			return err
		}
		keys := []string{SessionKey(sess.ID), UserLiveKey(sess.ClerkUserID)}
		if prevEID != "" {
			keys = append(keys, SessionKey(prevEID))
		}
		res, err := scriptCreateSession.run(ctx, s.client, keys,
			sess.ID, string(raw), SessionRedisTTLSec, UserLiveTTLSec, prevEID, msArg(now))
		if err != nil {
			return err
		}
		reply, _ := res.(string)
		if reply == "OK" {
			return nil
		}
		if !strings.HasPrefix(reply, "RETRY:") {
			return fmt.Errorf("enrollredis: CreateSession unexpected reply %q", reply)
		}
	}
	return errors.New("enrollredis: CreateSession concurrent modification retry limit")
}

func (s *RedisStore) GetSession(ctx context.Context, eid string) (*Session, error) {
	var sess Session
	if ok, err := s.getJSON(ctx, SessionKey(eid), &sess); !ok || err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *RedisStore) CancelSession(ctx context.Context, eid, uid string, now time.Time) (string, error) {
	res, err := scriptCancelSession.run(ctx, s.client, []string{SessionKey(eid), UserLiveKey(uid)},
		eid, uid, msArg(now), SessionRedisTTLSec)
	if err != nil {
		return "", err
	}
	reply, _ := res.(string)
	return reply, nil
}

func (s *RedisStore) AttestSession(ctx context.Context, in AttestInput) (AttestResult, error) {
	for attempt := 0; attempt < 3; attempt++ {
		sess, err := s.GetSession(ctx, in.EID)
		if err != nil {
			return AttestResult{}, err
		}
		if sess == nil {
			return AttestResult{Outcome: "refused", Reason: "enrollment_not_found"}, nil
		}
		var old *SCEPChallenge
		if sess.SCEPChalHash != "" {
			if old, err = s.GetSCEPChallenge(ctx, sess.SCEPChalHash); err != nil {
				return AttestResult{}, err
			}
		}
		out, err := s.attestOnce(ctx, in, sess, old)
		if err != nil || out.Outcome != "retry" {
			return out, err
		}
	}
	return AttestResult{}, errors.New("enrollredis: AttestSession concurrent retry limit")
}

// attestOnce runs attest_session.lua against what the caller read: sess and
// the previous challenge record (nil when none). The script answers "retry"
// when either changed since.
func (s *RedisStore) attestOnce(ctx context.Context, in AttestInput, sess *Session, old *SCEPChallenge) (AttestResult, error) {
	keys := []string{
		SessionKey(in.EID),
		SCEPChalKey(in.NewChalHash),
		UserLiveKey(sess.ClerkUserID),
		SCEPRefusalKey(in.EID),
	}
	var oldChalIdx, oldKeyIdx, oldTxIdx int
	var oldKey, oldTx string
	if sess.SCEPChalHash != "" && sess.SCEPChalHash != in.NewChalHash {
		keys = append(keys, SCEPChalKey(sess.SCEPChalHash))
		oldChalIdx = len(keys)
		if old != nil {
			oldKey, oldTx = old.KeySha256, old.TxID
			if oldKey != "" {
				keys = append(keys, SCEPKeyKey(oldKey))
				oldKeyIdx = len(keys)
			}
			if oldTx != "" {
				keys = append(keys, SCEPTxKey(HashTxID(oldTx)))
				oldTxIdx = len(keys)
			}
		}
	}
	res, err := scriptAttestSession.run(ctx, s.client, keys,
		msArg(in.Now), in.Serial, in.UDIDSha256, in.AppleSignerSha256, in.Product,
		in.OSVersion, in.DeviceName, in.Platform, in.NewChalHash,
		SCEPChalTTLSec, SessionRedisTTLSec, in.RefusalCode, sess.SCEPChalHash,
		oldChalIdx, oldKeyIdx, oldTxIdx, oldKey, oldTx,
	)
	if err != nil {
		return AttestResult{}, err
	}
	var out AttestResult
	raw, _ := res.(string)
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return AttestResult{}, fmt.Errorf("enrollredis: decode attest reply: %w", err)
	}
	return out, nil
}

func (s *RedisStore) MarkSessionRefused(ctx context.Context, eid, code string, now time.Time) error {
	_, err := scriptMarkSessionRefused.run(ctx, s.client, []string{SessionKey(eid)},
		code, msArg(now), SessionRedisTTLSec)
	return err
}

func (s *RedisStore) SealSession(ctx context.Context, sess *Session, cache SealedCache, now time.Time) error {
	cacheJSON, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	keys := []string{SessionKey(sess.ID), SealedKey(sess.ID), UserLiveKey(sess.ClerkUserID)}
	chalIdx := 0
	if sess.SCEPChalHash != "" {
		keys = append(keys, SCEPChalKey(sess.SCEPChalHash))
		chalIdx = len(keys)
	}
	res, err := scriptSealSession.run(ctx, s.client, keys,
		sess.ID, cache.DeviceID, string(cacheJSON), msArg(now),
		SessionRedisTTLSec, SealedCacheTTLSec, chalIdx)
	if err != nil {
		return err
	}
	if reply, _ := res.(string); reply != "OK" {
		return fmt.Errorf("enrollredis: SealSession reply %q", reply)
	}
	return nil
}

func (s *RedisStore) GetSealedCache(ctx context.Context, eid string) (*SealedCache, error) {
	var c SealedCache
	if ok, err := s.getJSON(ctx, SealedKey(eid), &c); !ok || err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *RedisStore) MarkSealing(ctx context.Context, eid, token string) (bool, error) {
	return s.client.SetNX(ctx, SealingKey(eid), token, SealingTTLSec*time.Second).Result()
}

func (s *RedisStore) ClearSealing(ctx context.Context, eid, token string) error {
	_, err := scriptClearSealing.run(ctx, s.client, []string{SealingKey(eid)}, token)
	return err
}

func (s *RedisStore) EnqueueNotice(ctx context.Context, ev NoticeEvent) error {
	return s.client.XAdd(ctx, &redis.XAddArgs{
		Stream: NoticeStreamKey,
		MaxLen: NoticeStreamMaxLen,
		Approx: true,
		Values: []any{
			"deviceId", ev.DeviceID,
			"email", ev.Email,
			"platform", ev.Platform,
			"model", ev.Model,
			"serialLast4", ev.SerialLast4,
		},
	}).Err()
}

func (s *RedisStore) GetSCEPChallenge(ctx context.Context, chalHashHex string) (*SCEPChallenge, error) {
	var c SCEPChallenge
	if ok, err := s.getJSON(ctx, SCEPChalKey(chalHashHex), &c); !ok || err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *RedisStore) GetSCEPKeyBinding(ctx context.Context, keyHashHex string) (*SCEPKeyBinding, error) {
	var kb SCEPKeyBinding
	if ok, err := s.getJSON(ctx, SCEPKeyKey(keyHashHex), &kb); !ok || err != nil {
		return nil, err
	}
	return &kb, nil
}

func decodeDecision(res any, what string) (SCEPDecision, error) {
	var d SCEPDecision
	raw, _ := res.(string)
	if err := json.Unmarshal([]byte(raw), &d); err != nil {
		return SCEPDecision{}, fmt.Errorf("enrollredis: decode %s reply: %w", what, err)
	}
	return d, nil
}

func (s *RedisStore) SCEPClaim(ctx context.Context, challenge, keyHashHex, txID, csrCN string, now time.Time) (SCEPDecision, error) {
	chalHash := HashChallenge(challenge)
	chal, err := s.GetSCEPChallenge(ctx, chalHash)
	if err != nil {
		return SCEPDecision{}, err
	}
	if chal == nil {
		return SCEPDecision{Allow: false, Outcome: "permit_not_found"}, nil
	}
	// The session is read here, not in the script: see scep_claim.lua.
	sessJSON, err := s.getString(ctx, SessionKey(chal.EID))
	if err != nil {
		return SCEPDecision{}, err
	}
	keys := []string{
		SCEPChalKey(chalHash),
		SCEPKeyKey(keyHashHex),
		SCEPTxKey(HashTxID(txID)),
		SCEPRefusalKey(chal.EID),
	}
	res, err := scriptSCEPClaim.run(ctx, s.client, keys,
		msArg(now), chalHash, keyHashHex, txID, csrCN, challenge, SCEPRefusalTTLSec, sessJSON, SCEPKeyBindingMaxTTLSec)
	if err != nil {
		return SCEPDecision{}, err
	}
	return decodeDecision(res, "SCEPClaim")
}

func (s *RedisStore) SCEPAuthorize(ctx context.Context, keyHashHex, csrCN string, now time.Time) (SCEPDecision, error) {
	kb, err := s.GetSCEPKeyBinding(ctx, keyHashHex)
	if err != nil {
		return SCEPDecision{}, err
	}
	if kb == nil {
		return SCEPDecision{Allow: false, Outcome: "permit_not_found"}, nil
	}
	sessJSON, err := s.getString(ctx, SessionKey(kb.EID))
	if err != nil {
		return SCEPDecision{}, err
	}
	keys := []string{
		SCEPKeyKey(keyHashHex),
		SCEPChalKey(kb.ChalHash),
		SCEPRefusalKey(kb.EID),
	}
	res, err := scriptSCEPAuthorize.run(ctx, s.client, keys, msArg(now), csrCN, SCEPRefusalTTLSec, sessJSON)
	if err != nil {
		return SCEPDecision{}, err
	}
	return decodeDecision(res, "SCEPAuthorize")
}

// MarkSCEPRefused records cahookrelay's refusal for a session. The first one
// wins (NX); it lives as long as a session.
func (s *RedisStore) MarkSCEPRefused(ctx context.Context, eid, code string) error {
	return s.client.SetNX(ctx, SCEPRefusalKey(eid), code, SCEPRefusalTTLSec*time.Second).Err()
}

func (s *RedisStore) GetSCEPRefusal(ctx context.Context, eid string) (string, error) {
	return s.getString(ctx, SCEPRefusalKey(eid))
}

// nonceTTLSec is a used-nonce key's TTL in whole seconds, rounded up, at least 1.
func nonceTTLSec(ttl time.Duration) int {
	return max(1, int(math.Ceil(ttl.Seconds())))
}

// remainingSec is the whole seconds left until exp, rounded up; ErrExpired when
// none are left.
func remainingSec(exp, now time.Time) (int, error) {
	left := exp.Sub(now)
	if left <= 0 {
		return 0, ErrExpired
	}
	return int(math.Ceil(left.Seconds())), nil
}

func (s *RedisStore) CreateACMEOrder(ctx context.Context, order ACMEOrder, authz ACMEAuthz, nonce string, nonceTTL time.Duration, maxOrdersPerDevice int, now time.Time) (string, error) {
	ttl, err := remainingSec(order.Expires, now)
	if err != nil {
		return "", err
	}
	orderJSON, err := json.Marshal(order)
	if err != nil {
		return "", err
	}
	authzJSON, err := json.Marshal(authz)
	if err != nil {
		return "", err
	}
	res, err := scriptACMECreateOrder.run(ctx, s.client,
		[]string{
			ACMEDeviceOrdersKey(order.DeviceID),
			ACMEOrderKey(order.ID),
			ACMEAuthzKey(authz.ID),
			ACMEUsedNonceKey(nonce),
		},
		maxOrdersPerDevice, string(orderJSON), string(authzJSON), ttl, nonceTTLSec(nonceTTL))
	if err != nil {
		return "", err
	}
	reply, _ := res.(string)
	return reply, nil
}

func (s *RedisStore) GetACMEOrder(ctx context.Context, orderID string) (*ACMEOrder, error) {
	var o ACMEOrder
	if ok, err := s.getJSON(ctx, ACMEOrderKey(orderID), &o); !ok || err != nil {
		return nil, err
	}
	return &o, nil
}

func (s *RedisStore) MoveACMEOrder(ctx context.Context, m ACMEOrderMove) (ACMEResult, error) {
	keys := []string{ACMEOrderKey(m.OrderID)}
	nonceIdx, nonceTTL := 0, 0
	if m.Nonce != "" {
		keys = append(keys, ACMEUsedNonceKey(m.Nonce))
		nonceIdx, nonceTTL = len(keys), nonceTTLSec(m.NonceTTL)
	}
	certIdx, certTTL, certJSON := 0, 0, []byte{}
	if m.Cert != nil {
		ttl, err := remainingSec(m.Cert.Expires, m.Now)
		if err != nil {
			return ACMEResult{}, err
		}
		if certJSON, err = json.Marshal(m.Cert); err != nil {
			return ACMEResult{}, err
		}
		keys = append(keys, ACMECertKey(m.CertID))
		certIdx, certTTL = len(keys), ttl
	}
	res, err := scriptACMEMoveOrder.run(ctx, s.client, keys,
		m.AccountID, m.DeviceID, m.From, m.To, nonceIdx, nonceTTL,
		certIdx, m.CertID, string(certJSON), certTTL, m.ErrorType, m.ErrorMsg)
	if err != nil {
		return ACMEResult{}, err
	}
	return decodeACMEResult(res, "MoveACMEOrder")
}

func (s *RedisStore) GetACMEAuthz(ctx context.Context, authzID string) (*ACMEAuthz, error) {
	var a ACMEAuthz
	if ok, err := s.getJSON(ctx, ACMEAuthzKey(authzID), &a); !ok || err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *RedisStore) AnswerACMEChallenge(ctx context.Context, a ACMEChallengeAnswer) (ACMEResult, error) {
	outcome, x5c := "invalid", []byte("[]")
	if a.Valid {
		outcome = "valid"
		var err error
		if x5c, err = json.Marshal(a.AttestedX5CB64); err != nil {
			return ACMEResult{}, err
		}
	}
	res, err := scriptACMEAnswerChallenge.run(ctx, s.client,
		[]string{ACMEAuthzKey(a.AuthzID), ACMEOrderKey(a.OrderID), ACMEUsedNonceKey(a.Nonce)},
		a.AccountID, a.DeviceID, a.ChalID, nonceTTLSec(a.NonceTTL), outcome,
		a.AttestedKeySha256, string(x5c), a.ValidatedAt, a.ErrorType, a.ErrorMsg)
	if err != nil {
		return ACMEResult{}, err
	}
	return decodeACMEResult(res, "AnswerACMEChallenge")
}

// decodeACMEResult reads a script's {outcome, status} reply.
func decodeACMEResult(res any, what string) (ACMEResult, error) {
	arr, ok := res.([]any)
	if !ok || len(arr) != 2 {
		return ACMEResult{}, fmt.Errorf("enrollredis: %s reply %v", what, res)
	}
	outcome, _ := arr[0].(string)
	status, _ := arr[1].(string)
	switch outcome {
	case ACMEOK, ACMENotFound, ACMEConflict, ACMENotPending, ACMEOrderMissing, ACMEBadNonce:
		return ACMEResult{Outcome: outcome, Status: status}, nil
	}
	return ACMEResult{}, fmt.Errorf("enrollredis: %s outcome %q", what, outcome)
}

func (s *RedisStore) GetACMECert(ctx context.Context, certID string) (*ACMECert, error) {
	var c ACMECert
	if ok, err := s.getJSON(ctx, ACMECertKey(certID), &c); !ok || err != nil {
		return nil, err
	}
	return &c, nil
}
