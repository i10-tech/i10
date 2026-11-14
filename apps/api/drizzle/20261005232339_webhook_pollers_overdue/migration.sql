-- Polling endpoints that have gone quiet with events waiting (#301, health
-- from #284). Asked about every tenant at once by the engine's tick, which
-- runs as `i10_api`; ids and clocks only, answered by the owner.
--
-- `quiet_since` is when collecting stopped: the later of the last poll (or
-- the endpoint's creation) and the oldest event still waiting. An endpoint
-- that has been around for months is not judged on months it had nothing to
-- collect.
CREATE FUNCTION "core"."webhook_pollers_overdue"(p_failing interval)
RETURNS TABLE (
  endpoint_id uuid,
  tenant_id uuid,
  quiet_since timestamptz,
  retry_policy core.webhook_retry_policy
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.id, e.tenant_id,
         greatest(coalesce(e.last_polled_at, e.created_at), w.oldest),
         w.retry_policy
    FROM core.webhook_endpoints e
    CROSS JOIN LATERAL (
      SELECT d.created_at AS oldest, d.retry_policy
        FROM core.webhook_deliveries d
       WHERE d.endpoint_id = e.id
         AND d.status = 'pending'
       ORDER BY d.created_at
       LIMIT 1
    ) w
   WHERE e.kind = 'polling'
     AND e.enabled
     AND greatest(coalesce(e.last_polled_at, e.created_at), w.oldest) < now() - p_failing
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."webhook_pollers_overdue"(interval) TO i10_api;
