-- Access domains due their nightly re-check (#326), across every tenant at
-- once. Replaces the `join_domains_recheck_read` policy (0129), which let any
-- connection read every row by turning on `app.join_recheck`; this answers
-- only the rows due a check, only the fields the check needs, and is run as
-- `i10_api` by the re-check job. Writes still go through each row's tenant.
--
-- Never-checked rows first, then the oldest check; `p_limit` is capped so a
-- caller cannot ask for the whole table in one go.
CREATE FUNCTION "core"."join_domains_due"(p_before timestamptz, p_limit integer)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  name text,
  source text,
  token text,
  lapsed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT d.id, d.tenant_id, d.name, d.source, d.token, d.lapsed_at
    FROM core.join_domains d
   WHERE (d.verified_at IS NOT NULL OR d.source = 'domains')
     AND d.displaced_at IS NULL
     AND (d.checked_at IS NULL OR d.checked_at < p_before)
   ORDER BY d.checked_at NULLS FIRST
   LIMIT least(greatest(p_limit, 0), 1000)
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."join_domains_due"(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."join_domains_due"(timestamptz, integer) TO i10_api;
