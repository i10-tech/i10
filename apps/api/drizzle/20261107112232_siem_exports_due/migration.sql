-- Workspaces whose SIEM export is due (#345), across every tenant at once.
--
-- ⚠ HAND-WRITTEN BECAUSE DRIZZLE CANNOT MODEL A FUNCTION, on the pattern of
-- `identity.google_directories_due` (0142): a SECURITY DEFINER that answers
-- tenant ids only, so the scheduler runs as `i10_api` under row level security
-- instead of through a policy any session could open with a setting. The run
-- itself claims the row, and reads and writes everything else, as its own
-- tenant.
--
-- Keyset paging by tenant id; `p_limit` is capped so one call cannot ask for all.
CREATE FUNCTION "identity"."siem_exports_due"(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity, pg_temp
AS $$
  SELECT s.tenant_id
    FROM identity.siem_exports s
   WHERE s.enabled
     AND s.next_run_at <= now()
     AND (p_after IS NULL OR s.tenant_id > p_after)
   ORDER BY s.tenant_id
   LIMIT least(greatest(p_limit, 0), 500)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "identity"."siem_exports_due"(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "identity"."siem_exports_due"(uuid, integer) TO i10_api;
