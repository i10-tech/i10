ALTER TABLE "core"."meter_events" ADD COLUMN "ingested_at" timestamp with time zone;--> statement-breakpoint

-- ⚠ A PARTIAL INDEX, BECAUSE THE FLUSH ONLY EVER ASKS FOR THE UNSENT ONES AND
-- THEY ARE THE SMALL MINORITY. On a healthy deployment this index holds a few
-- minutes of usage; a full index on `ingested_at` would grow with every message
-- ever sent, to answer a query that never looks at any of them.
CREATE INDEX "meter_events_unshipped_idx"
  ON "core"."meter_events" USING btree ("feature_id", "occurred_at")
  WHERE "ingested_at" IS NULL;
--> statement-breakpoint

-- ⚠ ROWS THAT PREDATE THE INGEST ARE MARKED AS ALREADY SENT, AND THAT IS THE
-- SAFE DIRECTION. Leaving them NULL would make the first flush post every unit
-- ever recorded to Polar — attributed by RECEIPT time, so an entire back
-- catalogue would land in the current billing period and appear on one
-- customer's invoice as a single enormous month.
UPDATE core.meter_events SET ingested_at = now() WHERE ingested_at IS NULL;
--> statement-breakpoint

-- Everything not yet in Polar's meter, across every tenant.
--
-- ⚠ CROSS-TENANT, SO A SECURITY DEFINER FUNCTION — same reason as
-- `sent_usage_snapshot`: the flush job holds no tenant context, and under the
-- policy it would see one tenant's usage and conclude everyone else had sent
-- nothing. It returns a count, an id and a timestamp; no address, no subject.
--
-- ⚠ ORDERED BY `occurred_at`, WHICH IS WHAT KEEPS A BACKLOG FROM STARVING. A
-- limit with no order lets Postgres return the same convenient page forever
-- while the oldest rows are never picked up.
CREATE FUNCTION "core"."unshipped_meter_events"(p_feature text, p_limit integer)
RETURNS TABLE (
  tenant_id uuid,
  event_id text,
  occurred_at timestamptz,
  value integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.tenant_id, e.event_id, e.occurred_at, e.value
    FROM core.meter_events e
   WHERE e.feature_id = p_feature
     AND e.ingested_at IS NULL
   ORDER BY e.occurred_at
   LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."unshipped_meter_events"(text, integer) TO i10_api;
