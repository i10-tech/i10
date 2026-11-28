-- step-ca's AUTHORIZING webhook (cahookrelay only): allow issuance for a key
-- the challenge hook bound to the session's current challenge.
--
-- ⚠ THE SESSION IS NOT A KEY OF THIS SCRIPT: the caller GETs it and passes its
-- JSON as ARGV[4] (see scep_claim.lua for why that is enough). Refusals go to
-- KEYS[3], and one recorded there is terminal: it is read first.
--
-- KEYS[1] = enroll:scep:key:<key_hash>
-- KEYS[2] = enroll:scep:chal:<chal_hash>
-- KEYS[3] = enroll:scep:refusal:<eid>
--
-- ARGV[1] = now (ms)   ARGV[2] = certificate CN   ARGV[3] = refusal TTL (s)
-- ARGV[4] = the session JSON as the caller read it ("" when there is none)
--
-- Returns JSON {allow, outcome}.
local function decide(allow, outcome)
  return cjson.encode({allow=allow, outcome=outcome})
end

local refused = redis.call('GET', KEYS[3])
if refused then return decide(false, refused) end

local kb_raw = redis.call('GET', KEYS[1])
if not kb_raw then return decide(false, 'permit_not_found') end
local kb = cjson.decode(kb_raw)
local now_ms = tonumber(ARGV[1])
if now_ms >= kb.expires_at_ms then return decide(false, 'permit_expired') end
if kb.status ~= 'challenged' and kb.status ~= 'authorized' then
  return decide(false, 'permit_not_challenged')
end

if ARGV[4] == '' then return decide(false, 'enrollment_not_found') end
local sess = cjson.decode(ARGV[4])
if sess.id ~= kb.eid then return decide(false, 'permit_superseded') end
if sess.status ~= 'attested' then return decide(false, 'enrollment_' .. sess.status) end
if now_ms >= sess.expires_at_ms then return decide(false, 'enrollment_expired') end
if sess.scep_chal_hash ~= kb.chal_hash then return decide(false, 'permit_superseded') end

local chal_raw = redis.call('GET', KEYS[2])
if not chal_raw then return decide(false, 'permit_not_found') end
local chal = cjson.decode(chal_raw)
if chal.key_sha256 ~= kb.key_sha256 then return decide(false, 'permit_superseded') end

if sess.serial ~= ARGV[2] or kb.serial ~= ARGV[2] then
  redis.call('SET', KEYS[3], 'serial_mismatch', 'EX', tonumber(ARGV[3]), 'NX')
  return decide(false, 'serial_mismatch')
end

local rem_sec = math.ceil((kb.expires_at_ms - now_ms) / 1000)
if rem_sec < 1 then rem_sec = 1 end
kb.status = 'authorized'
chal.status = 'authorized'
redis.call('SET', KEYS[1], cjson.encode(kb), 'EX', rem_sec)
redis.call('SET', KEYS[2], cjson.encode(chal), 'EX', rem_sec)
return decide(true, 'allowed')
