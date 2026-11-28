-- Cancel an open or attested enrollment owned by the caller's person.
--
-- ONE COPY, RUN BY BOTH apps/api (enroll-redis.ts) AND Go (enrollredis).
--
-- KEYS[1] = enroll:sess:<eid>
-- KEYS[2] = enroll:user:<uid>
--
-- ARGV[1] = eid
-- ARGV[2] = uid
-- ARGV[3] = now (ms)
-- ARGV[4] = session TTL (s)
--
-- Returns "cancelled" | "already_sealed" | "not_found". A session already
-- refused, expired or cancelled answers "cancelled" and is left as it is.
-- Its SCEP keys are left to their TTL, as in create_session.lua.
local raw = redis.call('GET', KEYS[1])
if not raw then return 'not_found' end
local sess = cjson.decode(raw)
if sess.clerk_user_id ~= ARGV[2] then return 'not_found' end
if sess.status == 'sealed' then return 'already_sealed' end
if sess.status == 'open' or sess.status == 'attested' then
  sess.status = 'cancelled'
  sess.updated_at_ms = tonumber(ARGV[3])
  redis.call('SET', KEYS[1], cjson.encode(sess), 'EX', tonumber(ARGV[4]))
  if redis.call('GET', KEYS[2]) == ARGV[1] then
    redis.call('DEL', KEYS[2])
  end
end
return 'cancelled'
