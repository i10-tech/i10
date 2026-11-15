-- The due function from 0104, now also returning each delivery's lane, so the
-- sweep re-queues a delivery onto the queue it belongs to (#277,
-- docs/decisions/webhooks.md decision 1). Dropped and recreated rather than
-- replaced: Postgres cannot change a function's result columns in place.
DROP FUNCTION "core"."webhook_deliveries_due"(interval, integer);
--> statement-breakpoint
CREATE FUNCTION "core"."webhook_deliveries_due"(p_grace interval, p_limit integer)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  endpoint_id uuid,
  occurred_at timestamptz,
  attempts integer,
  next_attempt_at timestamptz,
  lane core.webhook_delivery_lane
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.endpoint_id, d.occurred_at, d.attempts, d.next_attempt_at, d.lane
    FROM core.webhook_deliveries d
   WHERE d.status = 'pending'
     AND d.next_attempt_at <= now() - p_grace
     AND (d.claimed_until IS NULL OR d.claimed_until < now())
   ORDER BY d.next_attempt_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."webhook_deliveries_due"(interval, integer) TO i10_api;
