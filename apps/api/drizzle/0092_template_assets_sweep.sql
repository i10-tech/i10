-- Which deleted workspaces still hold template images (#244). The design is
-- docs/decisions/templates.md, "Template images".
--
-- ⚠ TENANT IDS ONLY, like 0076 and 0085. The content-store job runs as
-- `i10_api`; this tells it which workspaces have images to delete, and the
-- deleting itself runs per tenant, under RLS, through `withTenant`.
--
-- ⚠ A WORKSPACE WHOSE ROW IS GONE COUNTS AS DELETED. `template_assets` has no
-- foreign key to `tenants`, so its rows outlive a tenant row removed by hand;
-- those images are exactly the ones nobody else would ever find.
CREATE FUNCTION "core"."template_assets_orphaned"(p_limit integer)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT a.tenant_id
    FROM core.template_assets a
    LEFT JOIN core.tenants t ON t.id = a.tenant_id
   WHERE t.id IS NULL OR t.status = 'deleted'
   LIMIT p_limit
$$;
