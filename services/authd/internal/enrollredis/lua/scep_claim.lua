-- step-ca's SCEPCHALLENGE webhook (cahookrelay only): bind a live challenge to
-- the CSR's key and transaction. An identical retry is allowed; another key or
-- transaction for the same challenge is refused.
--
-- ⚠ THE SESSION IS NOT A KEY OF THIS SCRIPT. cahookrelay's ACL is read-only on
-- enroll:sess:*, so it cannot attest a session, change its challenge, serial or
-- person; and Redis checks every EVALSHA key for WRITE access, so a read-only
-- key cannot be in KEYS at all. The caller GETs the session first and passes
-- its JSON as ARGV[8]. That read is not atomic with the claim, and need not be:
-- this verdict only lets step-ca issue a Phase 4 certificate, which grants
-- nothing by itself, and enrollctl re-reads the session before it mints.
-- A refusal the console must show goes to KEYS[4] (enroll:scep:refusal:<eid>),
-- which the API reads and enrollctl acts on.
--
-- ⚠ A RECORDED REFUSAL IS TERMINAL. It is read first, so after a
-- serial_mismatch or scep_key_conflict no later claim of the same challenge
-- is allowed, even with the right serial and key.
--
-- ⚠ THE BINDING CARRIES THE CHALLENGE PLAINTEXT step-ca SENT (ARGV[6]), and
-- enrollctl's finish requires sha256(challenge) to equal the session's CURRENT
-- scep_chal_hash. That stops a party who can only write Redis from naming a
-- session. It does NOT stop the relay itself: step-ca sends it every in-flight
-- challenge in plaintext, so a compromised relay (or step-ca) can bind a
-- victim's in-flight enrollment to its own key. That is inherent to SCEP.
--
-- KEYS[1] = enroll:scep:chal:<chal_hash>
-- KEYS[2] = enroll:scep:key:<key_hash>
-- KEYS[3] = enroll:scep:tx:<sha256(tx_id)>
-- KEYS[4] = enroll:scep:refusal:<eid>
--
-- ARGV[1] = now (ms)      ARGV[2] = chal_hash   ARGV[3] = key_hash
-- ARGV[4] = tx_id         ARGV[5] = CSR CN      ARGV[6] = challenge plaintext
-- ARGV[7] = refusal TTL (s)
-- ARGV[8] = the session JSON as the caller read it ("" when there is none)
-- ARGV[9] = the key binding's TTL cap (s): the 30 minute hard cap
--
-- Returns JSON {allow, outcome}.
local function decide(allow, outcome)
  return cjson.encode({allow=allow, outcome=outcome})
end
local function refuse(code)
  redis.call('SET', KEYS[4], code, 'EX', tonumber(ARGV[7]), 'NX')
  return decide(false, code)
end

local refused = redis.call('GET', KEYS[4])
if refused then return decide(false, refused) end

local chal_raw = redis.call('GET', KEYS[1])
if not chal_raw then return decide(false, 'permit_not_found') end
local chal = cjson.decode(chal_raw)
local now_ms = tonumber(ARGV[1])
if now_ms >= chal.expires_at_ms then return decide(false, 'permit_expired') end

if ARGV[8] == '' then return decide(false, 'enrollment_not_found') end
local sess = cjson.decode(ARGV[8])
if sess.id ~= chal.eid then return decide(false, 'permit_superseded') end
if sess.status ~= 'attested' then return decide(false, 'enrollment_' .. sess.status) end
if now_ms >= sess.expires_at_ms then return decide(false, 'enrollment_expired') end
if sess.scep_chal_hash ~= ARGV[2] then return decide(false, 'permit_superseded') end
if sess.serial ~= ARGV[5] or chal.serial ~= ARGV[5] then return refuse('serial_mismatch') end

if chal.status == 'challenged' or chal.status == 'authorized' then
  if chal.key_sha256 == ARGV[3] and chal.tx_id == ARGV[4] then
    return decide(true, 'allowed_retry')
  end
  return refuse('scep_key_conflict')
end
if chal.status ~= 'open' then return decide(false, 'permit_not_open') end

local existing_key = redis.call('GET', KEYS[2])
if existing_key and cjson.decode(existing_key).chal_hash ~= ARGV[2] then
  return decide(false, 'key_in_use')
end
local existing_tx = redis.call('GET', KEYS[3])
if existing_tx and existing_tx ~= ARGV[2] then
  return decide(false, 'transaction_in_use')
end

local rem_sec = math.ceil((chal.expires_at_ms - now_ms) / 1000)
if rem_sec < 1 then rem_sec = 1 end
-- The binding's key lives as long as the session's attested window (attest
-- sets the challenge and the session to the same expiry, so this is the
-- challenge's life unless the session changed), never past the hard cap.
local kb_sec = math.ceil((sess.expires_at_ms - now_ms) / 1000)
if kb_sec < rem_sec then kb_sec = rem_sec end
if kb_sec > tonumber(ARGV[9]) then kb_sec = tonumber(ARGV[9]) end

chal.status = 'challenged'
chal.key_sha256 = ARGV[3]
chal.tx_id = ARGV[4]
local kb = {
  eid = sess.id,
  clerk_user_id = sess.clerk_user_id,
  serial = sess.serial,
  chal_hash = ARGV[2],
  challenge = ARGV[6],
  key_sha256 = ARGV[3],
  tx_id = ARGV[4],
  status = 'challenged',
  expires_at_ms = chal.expires_at_ms,
}
redis.call('SET', KEYS[1], cjson.encode(chal), 'EX', rem_sec)
redis.call('SET', KEYS[2], cjson.encode(kb), 'EX', kb_sec)
redis.call('SET', KEYS[3], ARGV[2], 'EX', rem_sec)
return decide(true, 'allowed')
