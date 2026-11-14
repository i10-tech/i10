-- Replays that need a worker (#282): queued, or running with a lapsed lease
-- (the worker that held it stopped). The same narrow shape as
-- `webhook_deliveries_due`: ids only, answered by the owner, because the worker
-- asks about every tenant at once and runs as `i10_api`.
CREATE FUNCTION "core"."webhook_replays_due"(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT r.id, r.tenant_id
    FROM core.webhook_replays r
   WHERE r.status IN ('queued', 'running')
     AND (r.claimed_until IS NULL OR r.claimed_until < now())
   ORDER BY r.created_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."webhook_replays_due"(integer) TO i10_api;
