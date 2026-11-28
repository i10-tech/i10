package enrollredis

import (
	"context"
	_ "embed"
	"strings"

	"github.com/redis/go-redis/v9"
)

// Every Lua script run against i10-enroll-redis is a file in lua/, embedded
// here. ⚠ create_session.lua AND cancel_session.lua ARE ALSO THE API'S COPY:
// apps/api/src/mail-devices/enroll-redis.ts imports the same files as text, so
// the script production runs is the script these tests and enrollload run.
//
// ⚠ EVERY KEY A SCRIPT TOUCHES IS IN KEYS[] (never built inside Lua, never an
// empty placeholder), so each client's ACL key patterns apply to every command
// the script runs. Optional keys are appended and named by a 1-based index in
// ARGV (0 when absent).
//
// ⚠ EVERY KEY WRITTEN HAS A POSITIVE TTL, under maxmemory-policy noeviction.

var (
	//go:embed lua/create_session.lua
	luaCreateSession string
	//go:embed lua/cancel_session.lua
	luaCancelSession string
	//go:embed lua/attest_session.lua
	luaAttestSession string
	//go:embed lua/scep_claim.lua
	luaSCEPClaim string
	//go:embed lua/scep_authorize.lua
	luaSCEPAuthorize string
	//go:embed lua/mark_session_refused.lua
	luaMarkSessionRefused string
	//go:embed lua/seal_session.lua
	luaSealSession string
	//go:embed lua/acme_create_order.lua
	luaACMECreateOrder string
	//go:embed lua/clear_sealing.lua
	luaClearSealing string
	//go:embed lua/acme_move_order.lua
	luaACMEMoveOrder string
	//go:embed lua/acme_answer_challenge.lua
	luaACMEAnswerChallenge string
)

var (
	scriptCreateSession       = newScript(luaCreateSession)
	scriptCancelSession       = newScript(luaCancelSession)
	scriptAttestSession       = newScript(luaAttestSession)
	scriptSCEPClaim           = newScript(luaSCEPClaim)
	scriptSCEPAuthorize       = newScript(luaSCEPAuthorize)
	scriptMarkSessionRefused  = newScript(luaMarkSessionRefused)
	scriptSealSession         = newScript(luaSealSession)
	scriptACMECreateOrder     = newScript(luaACMECreateOrder)
	scriptClearSealing        = newScript(luaClearSealing)
	scriptACMEMoveOrder       = newScript(luaACMEMoveOrder)
	scriptACMEAnswerChallenge = newScript(luaACMEAnswerChallenge)
)

// script runs one Lua file by EVALSHA, loading it with SCRIPT LOAD on NOSCRIPT
// (a Redis restart forgets every script).
//
// ⚠ NOT go-redis's Script.Run, WHICH FALLS BACK TO EVAL. EVALSHA plus SCRIPT
// LOAD is what the API's ioredis client does too, so no ACL user needs +eval.
type script struct{ s *redis.Script }

func newScript(src string) script { return script{redis.NewScript(src)} }

func (sc script) run(ctx context.Context, c redis.Scripter, keys []string, args ...any) (any, error) {
	res, err := sc.s.EvalSha(ctx, c, keys, args...).Result()
	if err != nil && strings.HasPrefix(err.Error(), "NOSCRIPT") {
		if err := sc.s.Load(ctx, c).Err(); err != nil {
			return nil, err
		}
		res, err = sc.s.EvalSha(ctx, c, keys, args...).Result()
	}
	return res, err
}

const (
	// SessionKeyPrefix stores one enrollment session JSON document.
	SessionKeyPrefix = "enroll:sess:"
	// UserLiveKeyPrefix stores the user's current live enrollment id (M5).
	UserLiveKeyPrefix = "enroll:user:"
	// SCEPChalKeyPrefix maps sha256(scep_challenge) -> challenge record JSON.
	SCEPChalKeyPrefix = "enroll:scep:chal:"
	// SCEPKeyKeyPrefix maps sha256(csr_spki) -> key binding JSON.
	SCEPKeyKeyPrefix = "enroll:scep:key:"
	// SCEPTxKeyPrefix maps sha256(transaction_id) -> active chal_hash.
	SCEPTxKeyPrefix = "enroll:scep:tx:"
	// SCEPRefusalKeyPrefix holds the refusal cahookrelay recorded for a session
	// (it may not write sessions); the API shows it, enrollctl acts on it.
	SCEPRefusalKeyPrefix = "enroll:scep:refusal:"
	// SealedKeyPrefix stores the M2 retry cache (signed sealed profile DER + key hash).
	SealedKeyPrefix = "enroll:sealed:"
	// SealingKeyPrefix holds the random token of the one finish attempt
	// allowed to mint an enrollment. An attempt acquires it with SET NX
	// (MarkSealing) and only the holder mints; any other attempt answers from
	// the sealed cache or 503 seal_in_flight. The holder releases it with a
	// compare-and-delete on its own token (clear_sealing.lua) after its seal,
	// or after a failed mint, so it never clears a marker another attempt
	// acquired after it expired.
	SealingKeyPrefix = "enroll:sealing:"
	// NoticeStreamKey is the capped Redis stream for post-seal notice emails.
	NoticeStreamKey = "enroll:notice"

	// ACME server keys (all under enroll:acme:* for acmed's ACL). There is no
	// account key (an ACME account is its key, named by a MACed URL) and no
	// serial gate (a Mac's ACME window is the path token in its profile).
	ACMEUsedNonceKeyPrefix    = "enroll:acme:used:"
	ACMEDeviceOrdersKeyPrefix = "enroll:acme:dev_orders:"
	ACMEOrderKeyPrefix        = "enroll:acme:order:"
	ACMEAuthzKeyPrefix        = "enroll:acme:authz:"
	ACMECertKeyPrefix         = "enroll:acme:cert:"
)

// Key helpers for callers.
func SessionKey(eid string) string          { return SessionKeyPrefix + eid }
func UserLiveKey(uid string) string         { return UserLiveKeyPrefix + uid }
func SCEPChalKey(chalHashHex string) string { return SCEPChalKeyPrefix + chalHashHex }
func SCEPKeyKey(keyHashHex string) string   { return SCEPKeyKeyPrefix + keyHashHex }
func SCEPTxKey(txHashHex string) string     { return SCEPTxKeyPrefix + txHashHex }
func SCEPRefusalKey(eid string) string      { return SCEPRefusalKeyPrefix + eid }
func SealedKey(eid string) string           { return SealedKeyPrefix + eid }
func SealingKey(eid string) string          { return SealingKeyPrefix + eid }

func ACMEUsedNonceKey(nonce string) string       { return ACMEUsedNonceKeyPrefix + nonce }
func ACMEDeviceOrdersKey(deviceID string) string { return ACMEDeviceOrdersKeyPrefix + deviceID }
func ACMEOrderKey(id string) string              { return ACMEOrderKeyPrefix + id }
func ACMEAuthzKey(id string) string              { return ACMEAuthzKeyPrefix + id }
func ACMECertKey(id string) string               { return ACMECertKeyPrefix + id }

const (
	// SessionRedisTTLSec keeps terminal session states readable by console polling
	// after seal/refusal/expiry (logical expiry is enforced by expires_at_ms).
	SessionRedisTTLSec = 3600
	// UserLiveTTLSec bounds the live-user pointer to the M4 hard cap (30 min).
	UserLiveTTLSec = 1800
	// SCEPChalTTLSec is the 10-minute life of one SCEP challenge.
	SCEPChalTTLSec = 600
	// SCEPKeyBindingMaxTTLSec caps a SCEP key binding at the M4 hard cap.
	SCEPKeyBindingMaxTTLSec = 30 * 60
	// SCEPRefusalTTLSec keeps a SCEP refusal as long as its session.
	SCEPRefusalTTLSec = SessionRedisTTLSec
	// SealedCacheTTLSec is the 120-second M2 sealed profile retry window.
	SealedCacheTTLSec = 120
	// SealingTTLSec outlives the batcher's worst case (a 4 s transaction plus
	// its queueing) and the seal after it, so a marker that is still there
	// means its attempt may still be sealing.
	SealingTTLSec = 30
	// NoticeStreamMaxLen caps the enroll:notice stream length.
	NoticeStreamMaxLen = 10000
)
