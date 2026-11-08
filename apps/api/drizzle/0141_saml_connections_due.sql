-- SAML connections for the daily metadata refresh and certificate expiry
-- alerts (#339), across every tenant at once.
--
-- ⚠ HAND-WRITTEN BECAUSE DRIZZLE CANNOT MODEL A FUNCTION, on the pattern of
-- `core.join_domains_due` (0130): a SECURITY DEFINER that answers ids and
-- tenant ids only, so the job runs as `i10_api` under row level security
-- instead of holding a role that can read every workspace's connections.
-- Every read and write after this goes through the row's own tenant.
--
-- Drafts are left out: nobody signs in through them, so nothing to alert on.
-- Keyset paging by id; `p_limit` is capped so one call cannot ask for all.
CREATE FUNCTION "identity"."saml_connections_due"(p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = identity, pg_temp
AS $$
  SELECT c.id, c.tenant_id
    FROM identity.connections c
   WHERE c.protocol = 'saml'
     AND c.status IN ('testing', 'active', 'disabled')
     AND (p_after IS NULL OR c.id > p_after)
   ORDER BY c.id
   LIMIT least(greatest(p_limit, 0), 500)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "identity"."saml_connections_due"(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "identity"."saml_connections_due"(uuid, integer) TO i10_api;
