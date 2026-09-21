-- Which of these tenant ids this database still holds.
--
-- ⚠ THE RECONCILER HAD NO WAY TO ASK, AND FOUND OUT BY CRASHING. It attributes
-- every Polar subscription by `customer.external_id`, which is a tenant id WE
-- wrote at checkout — and Polar keeps that value for ever, including after the
-- workspace it names has been deleted. The reconciler then read "no row for
-- this tenant" as "a webhook we never received", tried to repair it, and the
-- INSERT died on `subscriptions_tenant_id_tenants_id_fk`. Every thirty minutes,
-- for ever, counted as `failed` and exiting non-zero — which also held the
-- whole Argo Application at Degraded.
--
-- ⚠ THE MISS IS NOT THE SAME AS AN ABSENT ROW, AND THAT IS THE WHOLE POINT. A
-- tenant with no subscription row but a live tenant row is the ordinary
-- lost-webhook case this job exists to repair. A tenant id with no TENANT is a
-- subscription Polar is still billing for a workspace that no longer exists —
-- unrepairable here, and a money problem rather than a sync problem. Telling
-- them apart needs this read, before the write rather than after it.
--
-- ⚠ AND IT IS A DEFINER FUNCTION BECAUSE THE QUESTION SPANS TENANTS, the same
-- reason `core.subscriptions_snapshot()` is one. Row level security makes every
-- other workspace's tenant row invisible, so a request-scoped read would answer
-- "does not exist" for every tenant but the caller's — and this decides whether
-- a paying customer gets repaired or written off as unknown.
--
-- ⚠ IT TAKES IDS AND RETURNS THE KNOWN ONES rather than listing the table. The
-- caller only ever needs the intersection, the input is bounded by what Polar
-- returned, and handing back every tenant id to something that does not need
-- them is how a narrow function becomes a general-purpose read.
CREATE FUNCTION "core"."tenants_known"(p_ids uuid[])
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.id
    FROM core.tenants t
   WHERE t.id = ANY(p_ids);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."tenants_known"(uuid[]) TO i10_api;
