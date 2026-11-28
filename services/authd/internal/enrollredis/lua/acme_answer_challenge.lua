-- Record the answer to a pending device-attest-01 challenge (acmed only):
-- acmed verified the attestation first (pure CPU, no state); this script
-- requires the authorization pending and owned, spends the nonce, and moves
-- the authorization and its order in one step. Of N concurrent answers exactly
-- one moves them and spends; the rest see a challenge that is not pending and
-- spend nothing.
--
--   valid:   authz and challenge valid (with the attested key and chain), the
--            order pending -> ready;
--   invalid: authz and challenge invalid (with the error), the order
--            pending -> invalid.
--
-- ⚠ THE CHECKS COME BEFORE THE SPEND, AND THE SPEND BEFORE ANY WRITE.
--
-- KEYS[1] = enroll:acme:authz:<authz_id>
-- KEYS[2] = enroll:acme:order:<the authz's order_id>
-- KEYS[3] = enroll:acme:used:<nonce>
--
-- ARGV[1] = account thumbprint   ARGV[2] = device id   ARGV[3] = challenge id
-- ARGV[4] = TTL (s) of the used-nonce key
-- ARGV[5] = 'valid' | 'invalid'
-- ARGV[6] = attested key sha256   ARGV[7] = attested x5c (JSON array of base64)
-- ARGV[8] = validated at (RFC 3339)
-- ARGV[9] = error type   ARGV[10] = error detail   (invalid only)
--
-- Both keys keep their own TTL (KEEPTTL).
--
-- Returns {outcome, challenge status}: outcome 'OK' | 'not_found' |
-- 'not_pending' | 'order_missing' | 'bad_nonce'.
local raw = redis.call('GET', KEYS[1])
if not raw then return {'not_found', ''} end
local a = cjson.decode(raw)
if a.account_id ~= ARGV[1] or a.device_id ~= ARGV[2] or a.chal_id ~= ARGV[3] then
  return {'not_found', ''}
end
if a.chal_status ~= 'pending' then return {'not_pending', a.chal_status} end
local oraw = redis.call('GET', KEYS[2])
if not oraw then return {'order_missing', a.chal_status} end
local o = cjson.decode(oraw)
if o.id ~= a.order_id then return {'order_missing', a.chal_status} end
if not redis.call('SET', KEYS[3], '1', 'NX', 'EX', tonumber(ARGV[4])) then
  return {'bad_nonce', a.chal_status}
end
if ARGV[5] == 'valid' then
  a.status = 'valid'
  a.chal_status = 'valid'
  a.attested_key_sha256 = ARGV[6]
  a.attested_x5c_b64 = cjson.decode(ARGV[7])
  a.validated_at = ARGV[8]
  if o.status == 'pending' then o.status = 'ready' end
else
  a.status = 'invalid'
  a.chal_status = 'invalid'
  a.error_type = ARGV[9]
  a.error_msg = ARGV[10]
  if o.status == 'pending' then
    o.status = 'invalid'
    o.error_type = ARGV[9]
    o.error_msg = ARGV[10]
  end
end
redis.call('SET', KEYS[1], cjson.encode(a), 'KEEPTTL')
redis.call('SET', KEYS[2], cjson.encode(o), 'KEEPTTL')
return {'OK', a.chal_status}
