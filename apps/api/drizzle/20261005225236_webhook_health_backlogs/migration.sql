-- Webhook health changes still owed work (#284). Both readers ask about every
-- tenant at once and run as `i10_api`, so, like `webhook_replays_due`, these
-- answer with ids only and as the owner.

-- Not yet fanned out as `webhook_endpoint.*` webhooks. The grace leaves each
-- one to the worker that recorded it; this is for a worker that stopped first.
CREATE FUNCTION "core"."webhook_health_unfanned"(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.id, e.tenant_id
    FROM core.webhook_health_events e
   WHERE e.fanned_out_at IS NULL
     AND e.occurred_at < now() - interval '30 seconds'
   ORDER BY e.occurred_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."webhook_health_unfanned"(integer) TO i10_api;
--> statement-breakpoint
-- Workspaces with changes their owner has not been emailed about, and that no
-- API replica is emailing right now.
CREATE FUNCTION "core"."webhook_health_unemailed"(p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT e.tenant_id
    FROM core.webhook_health_events e
   WHERE e.emailed_at IS NULL
     AND (e.email_claimed_until IS NULL OR e.email_claimed_until < now())
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."webhook_health_unemailed"(integer) TO i10_api;
