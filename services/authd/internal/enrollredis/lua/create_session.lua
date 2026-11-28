-- Create an open enrollment session and cancel the person's earlier live one
-- in the same step (M5: one live enrollment per person).
--
-- ONE COPY, RUN BY BOTH apps/api (enroll-redis.ts, the production caller) AND
-- Go (enrollredis.RedisStore, tests and enrollload). Every key is in KEYS, so
-- the caller's Redis ACL is enforced on each command.
--
-- KEYS[1] = enroll:sess:<new_eid>
-- KEYS[2] = enroll:user:<uid>
-- KEYS[3] = enroll:sess:<prev_eid>, only when ARGV[5] names a previous eid
--
-- ARGV[1] = new_eid
-- ARGV[2] = new session JSON
-- ARGV[3] = session TTL (s)
-- ARGV[4] = live-pointer TTL (s)
-- ARGV[5] = the previous eid the caller read from KEYS[2] ("" if none)
-- ARGV[6] = now (ms)
--
-- Returns "OK", or "RETRY:<eid>" when KEYS[2] changed since the caller read it
-- (KEYS[3] would then name the wrong session).
--
-- The previous session's SCEP keys are left to their TTL: the API may not
-- touch enroll:scep:*, and cahookrelay and enrollctl refuse anything for a
-- session that is no longer attested.
local cur = redis.call('GET', KEYS[2])
if (cur or '') ~= ARGV[5] then
  return 'RETRY:' .. (cur or '')
end
if cur and #KEYS >= 3 then
  local raw = redis.call('GET', KEYS[3])
  if raw then
    local prev = cjson.decode(raw)
    if prev.status == 'open' or prev.status == 'attested' then
      prev.status = 'cancelled'
      prev.updated_at_ms = tonumber(ARGV[6])
      redis.call('SET', KEYS[3], cjson.encode(prev), 'EX', tonumber(ARGV[3]))
    end
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[4]))
return 'OK'
