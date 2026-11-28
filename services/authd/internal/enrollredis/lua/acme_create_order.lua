-- ACME newOrder (acmed only): under the device's order cap, spend the
-- request's nonce, then store the order and its authorization.
--
-- acmed calls this only for a request under a verified path token
-- (enrolltoken.VerifyACMEPath), which only the Mac's sealed profile carries,
-- and whose serial is the order's.
--
-- ⚠ THE CAP IS PER DEVICE ID, NOT PER SERIAL OR ACCOUNT. An account is only a
-- key, which anyone can generate; a serial is not secret and outlives one
-- enrollment, so a per-serial cap let a stranger poison a re-enrollment. A
-- re-enrollment is a new device id with a fresh cap.
--
-- ⚠ THE NONCE IS SPENT HERE, AFTER THE CAP, so a refused order writes
-- nothing (not even the used-nonce key).
--
-- KEYS[1] = enroll:acme:dev_orders:<device_id>
-- KEYS[2] = enroll:acme:order:<order_id>
-- KEYS[3] = enroll:acme:authz:<authz_id>
-- KEYS[4] = enroll:acme:used:<nonce>
--
-- ARGV[1] = max orders per device   ARGV[2] = order JSON   ARGV[3] = authz JSON
-- ARGV[4] = TTL (s): the order's remaining lifetime
-- ARGV[5] = TTL (s) of the used-nonce key
--
-- Returns "OK" | "order_cap_exceeded" | "bad_nonce".
local ttl = tonumber(ARGV[4])
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur >= tonumber(ARGV[1]) then
  return 'order_cap_exceeded'
end
if not redis.call('SET', KEYS[4], '1', 'NX', 'EX', tonumber(ARGV[5])) then
  return 'bad_nonce'
end
if redis.call('INCR', KEYS[1]) == 1 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ttl)
redis.call('SET', KEYS[3], ARGV[3], 'EX', ttl)
return 'OK'
