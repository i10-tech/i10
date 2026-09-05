-- The four questions the reconciler asks that no tenant-scoped connection can
-- answer.
--
-- ⚠ THESE ARE NOT AN OPTIMISATION — WITHOUT THEM THE RECONCILER CANNOT RUN AT
-- ALL. Every policy in `core` reads `current_setting('app.tenant_id')` strictly,
-- and only a `withTenant()` transaction sets it, so a cross-tenant read issued
-- from the job raises `unrecognized configuration parameter` on its first
-- statement. That is 0002 working exactly as designed: it fails loudly rather
-- than returning nothing and looking like an empty account.
--
-- Same shape as `sweep_stuck_messages`, `message_owner`, `subscriptions_snapshot`
-- and `provision_tenant`, and held to the same rule: one narrow question,
-- answered by the owner, returning the minimum. None of them exposes an
-- address, a subject or a message body — only counts, ids and the tenant names
-- the reconciler already prints in its own report.
--
-- ⚠ AND THEY ARE `STABLE`, NOT `VOLATILE`, so each can be planned as one scan
-- rather than re-executed per output row.

-- What i10 believes it sent, per tenant per day.
--
-- ⚠ CLOCKED ON `sent_at` AND BUCKETED IN UTC, WHICH THE METER SIDE BELOW COPIES
-- EXACTLY. Two sides bucketing on different clocks disagree by a boundary every
-- single day, and the reconciler then tops up the same messages forever. It
-- counts `sent` only: `queued`, `sending` and `failed` are not billable, and a
-- row in `sending` is genuinely undecided.
CREATE FUNCTION "core"."sent_usage_snapshot"(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  tenant_id uuid,
  period_start timestamp,
  count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.tenant_id,
         date_trunc('day', m.sent_at AT TIME ZONE 'UTC'),
         count(*)
    FROM core.messages m
   WHERE m.status = 'sent'
     AND m.sent_at >= p_from
     AND m.sent_at <  p_to
   GROUP BY 1, 2
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."sent_usage_snapshot"(timestamptz, timestamptz) TO i10_api;
--> statement-breakpoint

-- What the ledger holds, in the same buckets.
--
-- ⚠ `sum(value)`, NOT `count(*)`. A row is not necessarily one unit — the
-- column exists so a future metered feature can consume more than one per
-- event — and counting rows would silently bill every such feature at one.
CREATE FUNCTION "core"."meter_usage_snapshot"(
  p_feature text,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS TABLE (
  tenant_id uuid,
  period_start timestamp,
  count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT e.tenant_id,
         date_trunc('day', e.occurred_at AT TIME ZONE 'UTC'),
         sum(e.value)
    FROM core.meter_events e
   WHERE e.feature_id = p_feature
     AND e.occurred_at >= p_from
     AND e.occurred_at <  p_to
   GROUP BY 1, 2
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."meter_usage_snapshot"(text, timestamptz, timestamptz) TO i10_api;
--> statement-breakpoint

-- Every active tenant, for the check that they all have a plan.
CREATE FUNCTION "core"."active_tenants_snapshot"()
RETURNS TABLE (
  tenant_id uuid,
  slug text,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.id, t.slug, t.name
    FROM core.tenants t
   WHERE t.status = 'active'
   ORDER BY t.created_at
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."active_tenants_snapshot"() TO i10_api;
--> statement-breakpoint

-- Every tenant that holds a plan.
--
-- ⚠ THE COMPARISON AGAINST THE LIST ABOVE IS A DIFFERENT KIND OF CHECK FROM THE
-- USAGE ONE. A usage discrepancy is a number that drifted. A tenant with no
-- assignment has no allowance at all: every quota check for them resolves to
-- `unentitled`, which fails open, so they send unmetered and unbilled forever
-- — and the usage reconciler cannot notice, because both sides read zero and
-- agree.
CREATE FUNCTION "core"."assigned_tenant_ids"()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT a.tenant_id FROM core.plan_assignments a
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."assigned_tenant_ids"() TO i10_api;
