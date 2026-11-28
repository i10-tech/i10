-- Record a completed Phase 4 seal (enrollctl only), after the mint committed.
--
-- ⚠ IT OVERWRITES WHATEVER STATUS IS THERE. Once the device row exists the
-- session IS sealed, whatever a concurrent cancel or refusal wrote meanwhile.
-- The same overwrite makes a retry of this script idempotent.
--
-- A Mac's ACME window is not written here: it is the path token in the
-- profile's DirectoryURL (enrolltoken.SignACMEPath), which acmed verifies.
--
-- KEYS[1] = enroll:sess:<eid>
-- KEYS[2] = enroll:sealed:<eid>
-- KEYS[3] = enroll:user:<uid>
-- KEYS[ARGV[7]] = enroll:scep:chal:<chal_hash>  (DEL; index 0 when none)
--
-- ARGV[1] = eid   ARGV[2] = device id   ARGV[3] = sealed cache JSON
-- ARGV[4] = now (ms)   ARGV[5] = session TTL (s)   ARGV[6] = sealed cache TTL (s)
--
-- Returns 'OK', or 'not_found' when the session key is gone (which writes
-- nothing; the caller treats it as an error).
local raw = redis.call('GET', KEYS[1])
if not raw then return 'not_found' end
local sess = cjson.decode(raw)
sess.status = 'sealed'
sess.refusal = nil
sess.device_id = ARGV[2]
sess.updated_at_ms = tonumber(ARGV[4])
redis.call('SET', KEYS[1], cjson.encode(sess), 'EX', tonumber(ARGV[5]))
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[6]))
if redis.call('GET', KEYS[3]) == ARGV[1] then
  redis.call('DEL', KEYS[3])
end
local chal_idx = tonumber(ARGV[7])
if chal_idx > 0 then redis.call('DEL', KEYS[chal_idx]) end
return 'OK'
