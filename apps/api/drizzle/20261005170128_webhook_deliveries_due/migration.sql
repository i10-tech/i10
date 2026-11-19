-- Webhook deliveries that are owed an attempt and that nothing is working on
-- (#279, docs/decisions/webhooks.md "Durability").
--
-- ⚠ THE SAME SHAPE AS `sweep_stuck_messages`: one narrow question about every
-- tenant at once, answered by the owner, returning only what re-queueing needs.
-- No payload, no URL, no secret. The worker runs as `i10_api`, which no
-- tenant-scoped connection lets ask across tenants.
--
-- ⚠ `p_grace` IS WHAT KEEPS THIS FROM RACING THE QUEUE. A row that became due a
-- moment ago is the queue's to deliver; only one that has been due for longer
-- than the queue should ever take is the sweep's. The lease is the second
-- guard: a row a worker holds is never returned, whatever its due time.
CREATE FUNCTION "core"."webhook_deliveries_due"(p_grace interval, p_limit integer)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  endpoint_id uuid,
  occurred_at timestamptz,
  attempts integer,
  next_attempt_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.endpoint_id, d.occurred_at, d.attempts, d.next_attempt_at
    FROM core.webhook_deliveries d
   WHERE d.status = 'pending'
     AND d.next_attempt_at <= now() - p_grace
     AND (d.claimed_until IS NULL OR d.claimed_until < now())
   ORDER BY d.next_attempt_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."webhook_deliveries_due"(interval, integer) TO i10_api;
