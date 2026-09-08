-- The one question the API asks about tenants before it has a tenant.
--
-- ⚠ THE BOOT LOOKUP FOR `AUTH_EMAIL_FROM` READ `core.tenants` DIRECTLY, AND
-- THAT TABLE IS UNDER RLS. `tenant_isolation` (0002) compares `id` against
-- `current_setting('app.tenant_id')` strictly, and nothing has set it during
-- boot — so the query raised rather than returning a row, and the process died
-- before it could listen. 0002's own comment predicts the exact message:
-- `invalid input syntax for type uuid: ""`, the PgBouncer-flavoured form, which
-- reads like a bad parameter rather than a missing `withTenant()`.
--
-- ⚠ AND IT CANNOT BE FIXED BY WRAPPING IT IN `withTenant()`, WHICH IS WHY THIS
-- IS A DEFINER RATHER THAN A CALLER FIX. The transaction would need the tenant
-- id to set the parameter, and the id is precisely what the query exists to
-- find. Every other cross-tenant reader in `core` is resolved the same way —
-- see 0013, 0028 and 0030.
--
-- Held to their rule: one narrow question, answered by the owner, returning the
-- minimum. The id alone — the caller already knows the slug it asked for, and
-- the name and status are nobody's business at boot.
--
-- ⚠ NOT FILTERED ON `status`. A suspended i10 must still be able to send its
-- own verification codes; the alternative is an account lockout that locks out
-- the people who would undo it. Delivery is metered as unbilled anyway.
--
-- ⚠ STABLE, so the planner runs it once rather than per output row.
CREATE FUNCTION "core"."tenant_id_by_slug"(p_slug text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.id
    FROM core.tenants t
   WHERE t.slug = p_slug
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."tenant_id_by_slug"(text) TO i10_api;
