-- Workspaces the daily identity expiry pass has something to check in: an
-- OIDC connection (its client secret) or a SCIM directory (its stale sync and
-- its tokens), across every tenant at once.
--
-- ⚠ THE PASS USED TO READ `select id from core.tenants`, WHICH NEVER WORKED
-- AS `i10_api`. That table's policy casts `app.tenant_id` to uuid, and with no
-- tenant set on the session the cast fails ("invalid input syntax for type
-- uuid"), so the OIDC secret, stale sync and token checks never ran.
--
-- HAND-WRITTEN BECAUSE DRIZZLE CANNOT MODEL A FUNCTION, on the pattern of
-- `identity.saml_connections_due` (0141): a SECURITY DEFINER that answers
-- tenant ids only. Every read and write after this goes through the tenant.
--
-- Keyset paging by tenant id; `p_limit` is capped so one call cannot ask for all.
CREATE FUNCTION "identity"."expiry_tenants_due"(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity, pg_temp
AS $$
  SELECT t.tenant_id
    FROM (
      SELECT c.tenant_id FROM identity.connections c WHERE c.protocol = 'oidc'
      UNION
      SELECT d.tenant_id FROM identity.directories d
    ) t
   WHERE p_after IS NULL OR t.tenant_id > p_after
   ORDER BY t.tenant_id
   LIMIT least(greatest(p_limit, 0), 500)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "identity"."expiry_tenants_due"(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "identity"."expiry_tenants_due"(uuid, integer) TO i10_api;
