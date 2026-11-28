-- Move an ACME order from one status to another (acmed only): a compare and
-- set, so of N concurrent requests on one order exactly one moves it.
--
-- acmed's transitions through it:
--   ready -> processing   finalize claims the order, spending its nonce, before
--                         it calls enrollctl;
--   processing -> valid   with the certificate, written here too;
--   processing -> invalid enrollctl refused;
--   processing -> ready   enrollctl unavailable: the client may finalize again;
--   pending -> ready      a valid challenge's half-finished order (repair),
--                         spending its nonce.
--
-- ⚠ THE CHECKS COME BEFORE THE SPEND, AND THE SPEND BEFORE ANY WRITE: a
-- refusal writes nothing, not even the used-nonce key.
--
-- KEYS[1]       = enroll:acme:order:<order_id>
-- KEYS[ARGV[5]] = enroll:acme:used:<nonce>     (SET NX; index 0: spend nothing)
-- KEYS[ARGV[7]] = enroll:acme:cert:<cert_id>   (SET; index 0: write no cert)
--
-- ARGV[1] = account thumbprint   ARGV[2] = device id (both must be the order's)
-- ARGV[3] = from status          ARGV[4] = to status
-- ARGV[5] = nonce key index      ARGV[6] = TTL (s) of the used-nonce key
-- ARGV[7] = cert key index       ARGV[8] = cert id   ARGV[9] = cert JSON
-- ARGV[10] = TTL (s) of the cert: the order's remaining lifetime
-- ARGV[11] = error type ('' sets none)   ARGV[12] = error detail
--
-- The order keeps its own TTL (KEEPTTL).
--
-- Returns {outcome, status}: outcome 'OK' | 'not_found' (absent, or another
-- account's or device's) | 'conflict' (not in the from status) | 'bad_nonce';
-- status is the order's status after the call ('' when not found).
local raw = redis.call('GET', KEYS[1])
if not raw then return {'not_found', ''} end
local o = cjson.decode(raw)
if o.account_id ~= ARGV[1] or o.device_id ~= ARGV[2] then
  return {'not_found', ''}
end
if o.status ~= ARGV[3] then return {'conflict', o.status} end
local nonce_idx = tonumber(ARGV[5])
if nonce_idx > 0 and not redis.call('SET', KEYS[nonce_idx], '1', 'NX', 'EX', tonumber(ARGV[6])) then
  return {'bad_nonce', o.status}
end
o.status = ARGV[4]
local cert_idx = tonumber(ARGV[7])
if cert_idx > 0 then
  redis.call('SET', KEYS[cert_idx], ARGV[9], 'EX', tonumber(ARGV[10]))
  o.cert_id = ARGV[8]
end
if ARGV[11] ~= '' then
  o.error_type = ARGV[11]
  o.error_msg = ARGV[12]
end
redis.call('SET', KEYS[1], cjson.encode(o), 'KEEPTTL')
return {'OK', o.status}
