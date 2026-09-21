-- Which tenant already holds a Polar subscription id.
--
-- ⚠ THIS EXISTS BECAUSE POLAR'S `external_id` IS IMMUTABLE, WHICH TURNS A
-- SURVIVABLE MISATTRIBUTION INTO A PERMANENT ONE. Polar deduplicates customers
-- by email and stamps `external_id` only when it CREATES one — so a customer
-- who deletes their workspace and signs up again carries their OLD tenant id
-- for ever. `release_subscription` (0047) fixed the direction where the live
-- tenant is claiming the id; this answers the other direction, which is every
-- subsequent event for that customer.
--
-- ⚠ AND "JUST REPAIR THE CUSTOMER" IS NOT AVAILABLE. Verified against Polar's
-- API 2026-09-21: `PATCH /v1/customers/{id}` with an `external_id` answers
-- `422 Customer external ID cannot be updated.` There is no way to make the
-- field name the live tenant, so the disagreement must be resolved on our side
-- or not at all.
--
-- ⚠ SECURITY DEFINER BECAUSE THE CALLER IS SCOPED TO THE WRONG TENANT. The
-- webhook arrives attributed to the tenant Polar names; under
-- `core.subscriptions`'s policy the row belonging to the tenant that actually
-- bought is invisible, so the caller cannot discover the disagreement at all —
-- it can only crash into the unique index, which is what it did.
--
-- ⚠ IT RETURNS ONE UUID AND NOTHING ELSE. Same rule as `release_subscription`
-- and `terminate_tenant`: one narrow question, answered by the owner, returning
-- the minimum. It reveals no plan, no status and no customer.
CREATE FUNCTION "core"."subscription_owner"(
  p_polar_subscription_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT s.tenant_id
    FROM core.subscriptions s
   WHERE s.polar_subscription_id = p_polar_subscription_id;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."subscription_owner"(text) TO i10_api;
