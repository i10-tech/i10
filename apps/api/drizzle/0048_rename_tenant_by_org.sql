-- Following a Clerk organization's name onto the tenant behind it.
--
-- ⚠ THE TWO NAMES ARE NOW ONE NAME, AND THIS IS THE HALF THAT KEEPS IT TRUE
-- WHEN THE RENAME HAPPENS ON CLERK'S SIDE. The console renames our row and then
-- asks Clerk to match; but the Team page mounts Clerk's own
-- `<OrganizationProfile />`, which has a rename field of its own. Without this,
-- using that field puts the two names back out of step — the exact state the
-- sync was added to end, reachable from a panel we render ourselves.
--
-- ⚠ SECURITY DEFINER FOR THE SAME REASON `provision_tenant` IS. A webhook
-- carries an organization id, never a tenant id, and `core.tenants` is
-- protected by `id = current_setting('app.tenant_id')` — so under the policy
-- this row is invisible and a plain UPDATE would report success having changed
-- nothing. One narrow question, answered by the owner, returning the minimum.
--
-- ⚠ IT WILL NOT RENAME A DEAD TENANT. A terminated workspace's row is kept as
-- a record of what it was; letting a late webhook edit it would rewrite
-- history, and a Clerk organization we have already torn down has no business
-- naming anything.
--
-- ⚠ AND IT RETURNS THE TENANT RATHER THAN A COUNT so the caller can say which
-- workspace moved, and can tell "renamed" from "an organization we do not
-- have" without a second query.
CREATE FUNCTION "core"."rename_tenant_by_org"(
  p_clerk_org_id text,
  p_name text
)
RETURNS TABLE (tenant_id uuid, renamed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_was text;
BEGIN
  SELECT t.id, t.name INTO v_id, v_was
    FROM core.tenants t
   WHERE t.clerk_org_id = p_clerk_org_id
     AND t.status <> 'deleted';

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  -- ⚠ NO WRITE WHEN THE NAME ALREADY MATCHES, AND THAT IS WHAT STOPS THE LOOP.
  -- The console renames our row, asks Clerk to match, and Clerk answers with an
  -- `organization.updated` webhook carrying the name we just set. Answering
  -- `renamed = false` there means the receiver logs nothing and writes nothing,
  -- so the exchange ends after one round trip instead of ringing back and
  -- forth.
  IF v_was = p_name THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  UPDATE core.tenants
     SET name = p_name, updated_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_id, true;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."rename_tenant_by_org"(text, text) TO i10_api;
