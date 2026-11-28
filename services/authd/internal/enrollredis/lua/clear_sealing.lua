-- Release a finish attempt's sealing marker (enrollctl only): delete
-- enroll:sealing:<eid> only while it still holds this attempt's token, so an
-- attempt never clears a marker another attempt acquired after it expired.
--
-- KEYS[1] = enroll:sealing:<eid>
-- ARGV[1] = this attempt's token
--
-- Returns 1 when deleted, 0 otherwise.
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
