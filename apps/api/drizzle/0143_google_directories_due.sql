-- Enabled Google Workspace directories for the 15-minute pull (#343), across
-- every tenant at once.
--
-- ⚠ HAND-WRITTEN BECAUSE DRIZZLE CANNOT MODEL A FUNCTION, on the pattern of
-- `identity.saml_connections_due` (0138) and `core.join_domains_due` (0130): a
-- SECURITY DEFINER that answers ids and tenant ids only, so the scheduler runs
-- as `i10_api` under row level security instead of through a policy any session
-- could open with a setting. Every read and write after this goes through the
-- row's own tenant.
--
-- Keyset paging by id; `p_limit` is capped so one call cannot ask for all.
CREATE FUNCTION "identity"."google_directories_due"(p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity, pg_temp
AS $$
  SELECT d.id, d.tenant_id
    FROM identity.directories d
   WHERE d.provider = 'google'
     AND d.enabled
     AND (p_after IS NULL OR d.id > p_after)
   ORDER BY d.id
   LIMIT least(greatest(p_limit, 0), 500)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "identity"."google_directories_due"(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "identity"."google_directories_due"(uuid, integer) TO i10_api;
