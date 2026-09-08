-- The tenants that are supposed to exist in Polar.
--
-- ⚠ POLAR HOLDS CUSTOMERS, NOT USERS, AND THE RECONCILER DID NOT KNOW THAT.
-- `active_tenants_snapshot` (0013) returns every active tenant, and
-- reconcile.ts asserts each one has a Polar customer — raising to Sentry and
-- exiting non-zero when any does not. Under Autumn that held, because
-- `ensureCustomer` created the provider-side customer at signup for everybody.
-- Retiring Autumn removed that half: a Polar customer is now created lazily, by
-- the checkout itself, from `external_customer_id`.
--
-- ⚠ SO THE FIRST FREE TENANT EVER PROVISIONED BROKE THE NIGHTLY JOB, AND IT WAS
-- RIGHT TO. Nothing was wrong with the tenant — a free account that never
-- checked out correctly has no customer record with a payment processor. The
-- check was asserting something that had stopped being true, which is the worst
-- kind of alert: it fires forever, on healthy state, until somebody stops
-- reading it.
--
-- This is the same question narrowed to the population it is true of: everyone
-- we believe is PAYING must exist in Polar. That comparison is worth waking
-- somebody for, because a paying tenant Polar has never heard of is revenue
-- that will never be invoiced.

-- ⚠ THE FREE PLAN IS A PARAMETER, NOT A LITERAL. `METERING_FREE_PLAN_ID` is
-- configurable and defaults to `free`; baking the string in here would let the
-- two drift, and the failure would be silent in the expensive direction — every
-- tenant looking paid, or none.
--
-- ⚠ A TENANT HOLDING NO ASSIGNMENT AT ALL IS NOT PAYING AND IS NOT RETURNED.
-- The inner join is doing that deliberately. Such a tenant is already a finding
-- of a different check — 0013's plan-assignment comparison, which exists
-- precisely because an unassigned tenant sends unmetered forever — and
-- reporting it here as well would double one problem into two alerts that no
-- single fix clears.
--
-- ⚠ STABLE, so the planner runs it once rather than per output row.
CREATE FUNCTION "core"."paying_tenants_snapshot"(p_free_plan_id text)
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
    JOIN core.plan_assignments a ON a.tenant_id = t.id
   WHERE t.status = 'active'
     AND a.plan_id <> p_free_plan_id
   ORDER BY t.created_at
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."paying_tenants_snapshot"(text) TO i10_api;
--> statement-breakpoint

-- ⚠ `active_tenants_snapshot` IS DELIBERATELY LEFT IN PLACE. 0013's
-- plan-assignment check still reads it, and that question — "does every active
-- tenant hold an allowance at all" — is about our own tables and is unrelated
-- to who pays. Dropping it here would take a working check down with a fix for
-- a different one.
SELECT 1;
