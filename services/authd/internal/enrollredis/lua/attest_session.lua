-- Phase 2 attest (enrollctl only): record the device, issue a new SCEP
-- challenge, retire the previous one.
--
--   - status must be open or attested and the session unexpired;
--   - a SCEP refusal cahookrelay recorded (KEYS[4]) moves the session to
--     refused here, since cahookrelay may not write sessions;
--   - first attest records the H2 binding (serial, UDID hash, Apple signer);
--     a retry must present the same three, else device_mismatch;
--   - every retry retires the previous challenge, its key binding and its
--     transaction, and creates one new challenge that lives
--     min(now + 10 min, created + 30 min) (M4).
--
-- ⚠ COMPARE-AND-SWAP ON EVERY SCEP FIELD THE CALLER READ. Go reads the session
-- and the previous challenge record to name the keys to retire; a SCEP claim in
-- between would leave a binding nobody retires. So the script re-reads them and
-- answers "retry" if the session's challenge hash, or the previous challenge's
-- claimed key or transaction, is not what the caller saw. A binding that still
-- slips through is harmless: finish requires its challenge to be the CURRENT one.
--
-- KEYS[1] = enroll:sess:<eid>
-- KEYS[2] = enroll:scep:chal:<new_chal_hash>
-- KEYS[3] = enroll:user:<uid>
-- KEYS[4] = enroll:scep:refusal:<eid>
-- KEYS[ARGV[14]] = enroll:scep:chal:<old_chal_hash>    (index 0 when none)
-- KEYS[ARGV[15]] = enroll:scep:key:<old_key_hash>      (index 0 when none)
-- KEYS[ARGV[16]] = enroll:scep:tx:<sha256(old_tx_id)>  (index 0 when none)
--
-- ARGV[1]  = now (ms)          ARGV[2]  = serial
-- ARGV[3]  = udid sha256 hex   ARGV[4]  = Apple signer sha256 hex
-- ARGV[5]  = product           ARGV[6]  = os version
-- ARGV[7]  = device name ("" keeps it unset)
-- ARGV[8]  = platform          ARGV[9]  = new challenge hash
-- ARGV[10] = challenge TTL (s) ARGV[11] = session TTL (s)
-- ARGV[12] = platform refusal code ("" when the platform is accepted)
-- ARGV[13] = expected session scep_chal_hash ("" when none)
-- ARGV[14..16] = indexes above
-- ARGV[17] = expected key_sha256 of the old challenge ("" when unclaimed)
-- ARGV[18] = expected tx_id of the old challenge ("" when unclaimed)
--
-- Returns JSON {outcome = scep | refused | retry, reason, serial, expires_at_ms}.
local raw = redis.call('GET', KEYS[1])
if not raw then
  return cjson.encode({outcome='refused', reason='enrollment_not_found'})
end
local sess = cjson.decode(raw)
local now_ms = tonumber(ARGV[1])
local sess_ttl = tonumber(ARGV[11])

local function drop_live_pointer()
  if redis.call('GET', KEYS[3]) == sess.id then
    redis.call('DEL', KEYS[3])
  end
end
local function finish_as(status, reason)
  sess.status = status
  if status == 'refused' then sess.refusal = reason end
  sess.updated_at_ms = now_ms
  redis.call('SET', KEYS[1], cjson.encode(sess), 'EX', sess_ttl)
  drop_live_pointer()
end
local function retire_old_keys()
  for _, i in ipairs({tonumber(ARGV[14]), tonumber(ARGV[15]), tonumber(ARGV[16])}) do
    if i > 0 then redis.call('DEL', KEYS[i]) end
  end
end

if sess.status ~= 'open' and sess.status ~= 'attested' then
  return cjson.encode({outcome='refused', reason='enrollment_' .. sess.status})
end
local scep_refusal = redis.call('GET', KEYS[4])
if scep_refusal then
  finish_as('refused', scep_refusal)
  return cjson.encode({outcome='refused', reason=scep_refusal})
end
if now_ms >= sess.expires_at_ms then
  finish_as('expired')
  return cjson.encode({outcome='refused', reason='enrollment_expired'})
end

if (sess.scep_chal_hash or '') ~= ARGV[13] then
  return cjson.encode({outcome='retry'})
end
local old_key, old_tx = '', ''
local old_idx = tonumber(ARGV[14])
if old_idx > 0 then
  local old_raw = redis.call('GET', KEYS[old_idx])
  if old_raw then
    local old = cjson.decode(old_raw)
    old_key = old.key_sha256 or ''
    old_tx = old.tx_id or ''
  end
end
if old_key ~= ARGV[17] or old_tx ~= ARGV[18] then
  return cjson.encode({outcome='retry'})
end

-- H2 first-attest lock: once attested, serial, UDID and Apple signer are fixed.
if sess.status == 'attested' then
  if sess.serial ~= ARGV[2] or sess.udid_sha256 ~= ARGV[3] or sess.apple_signer_sha256 ~= ARGV[4] then
    return cjson.encode({outcome='refused', reason='device_mismatch'})
  end
end

-- Platform refusal (mac_not_apple_silicon, macos_too_old, unsupported_product...).
if ARGV[12] ~= '' then
  sess.serial = ARGV[2]
  sess.product = ARGV[5]
  sess.os_version = ARGV[6]
  if ARGV[7] ~= '' then sess.device_name = ARGV[7] end
  sess.udid_sha256 = ARGV[3]
  sess.apple_signer_sha256 = ARGV[4]
  finish_as('refused', ARGV[12])
  retire_old_keys()
  return cjson.encode({outcome='refused', reason=ARGV[12]})
end

-- M4 hard cap: creation + 30 min; SCEP window: min(now + 10 min, hard cap).
local hard_cap = sess.created_at_ms + (30 * 60 * 1000)
if now_ms >= hard_cap then
  finish_as('expired')
  return cjson.encode({outcome='refused', reason='enrollment_expired'})
end
local new_exp = now_ms + (tonumber(ARGV[10]) * 1000)
if new_exp > hard_cap then new_exp = hard_cap end
local rem_sec = math.ceil((new_exp - now_ms) / 1000)
if rem_sec < 1 then rem_sec = 1 end

retire_old_keys()

sess.status = 'attested'
sess.serial = ARGV[2]
sess.udid_sha256 = ARGV[3]
sess.apple_signer_sha256 = ARGV[4]
sess.product = ARGV[5]
sess.os_version = ARGV[6]
if ARGV[7] ~= '' then sess.device_name = ARGV[7] end
sess.platform = ARGV[8]
sess.scep_chal_hash = ARGV[9]
sess.expires_at_ms = new_exp
sess.updated_at_ms = now_ms

local chal = {
  eid = sess.id,
  clerk_user_id = sess.clerk_user_id,
  serial = sess.serial,
  chal_hash = ARGV[9],
  status = 'open',
  expires_at_ms = new_exp,
}
redis.call('SET', KEYS[1], cjson.encode(sess), 'EX', sess_ttl)
redis.call('SET', KEYS[2], cjson.encode(chal), 'EX', rem_sec)
return cjson.encode({outcome='scep', serial=sess.serial, expires_at_ms=new_exp})
