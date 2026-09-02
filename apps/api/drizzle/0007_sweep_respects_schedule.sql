-- The sweeper must not resurrect a message that is not due yet.
--
-- ⚠ WITHOUT THIS, `scheduled_at` AND THE SWEEP FIGHT. The sweep exists to find
-- rows the queue lost — `queued` past a grace period, `sending` past the claim
-- timeout — and a message scheduled for next week is `queued` and older than any
-- grace period the moment the grace period elapses. It would be re-enqueued on
-- every pass, forever, and each of those jobs would then be refused by the claim
-- (which checks the same predicate) and dropped. Nothing would send early, but
-- the sweep would spend its whole budget on messages that are simply waiting,
-- and the rows it was meant to find would sit behind them.
--
-- A scheduled row that IS due and still `queued` is exactly what the sweep
-- should return, which `scheduled_at <= now()` keeps true.
CREATE OR REPLACE FUNCTION "core"."sweep_stuck_messages"(
  queued_grace interval,
  claim_timeout interval,
  max_rows integer
)
RETURNS TABLE (id uuid, created_at timestamptz, tenant_id uuid, queue text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.id, m.created_at, m.tenant_id, m.queue::text
    FROM core.messages m
   WHERE (m.scheduled_at IS NULL OR m.scheduled_at <= now())
     AND ( (m.status = 'queued'  AND m.created_at < now() - queued_grace)
        OR (m.status = 'sending' AND m.claimed_at < now() - claim_timeout) )
   ORDER BY m.created_at
   LIMIT max_rows;
$$;
