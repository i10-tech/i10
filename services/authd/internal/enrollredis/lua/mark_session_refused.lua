-- Mark an open or attested session refused so the console shows the reason
-- (enrollctl only; cahookrelay writes enroll:scep:refusal:<eid> instead).
--
-- KEYS[1] = enroll:sess:<eid>
-- ARGV[1] = refusal code   ARGV[2] = now (ms)   ARGV[3] = session TTL (s)
--
-- Returns "refused", "not_found" or the session's unchanged status.
local raw = redis.call('GET', KEYS[1])
if not raw then return 'not_found' end
local sess = cjson.decode(raw)
if sess.status == 'open' or sess.status == 'attested' then
  sess.status = 'refused'
  sess.refusal = ARGV[1]
  sess.updated_at_ms = tonumber(ARGV[2])
  redis.call('SET', KEYS[1], cjson.encode(sess), 'EX', tonumber(ARGV[3]))
  return 'refused'
end
return sess.status
