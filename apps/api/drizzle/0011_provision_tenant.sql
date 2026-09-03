-- Creating a tenant, which the tenant policy cannot express.
--
-- ⚠ THE POLICY ON `core.tenants` IS `id = current_setting('app.tenant_id')`, so
-- `i10_api` can only ever see the one tenant it is scoped to. That is right for
-- every request and impossible for a sign-up: the row does not exist yet, and
-- on a webhook retry it exists under an id the policy then hides — so the
-- application cannot tell "created" from "already there", which is the one
-- thing provisioning has to know.
--
-- Same shape as `sweep_stuck_messages`, `message_owner` and
-- `subscriptions_snapshot`, and held to the same rule: one narrow question,
-- answered by the owner, returning the minimum. It takes a Clerk organization
-- id and returns a tenant id — it cannot be turned into "show me another
-- tenant's data", because the caller must already hold an organization id that
-- Clerk gave us in a signature-verified webhook.
--
-- ⚠ AND IT IS IDEMPOTENT, WHICH IS NOT A NICETY. Svix redelivers, and a second
-- delivery must return the SAME tenant rather than a second one — a duplicate
-- tenant is a duplicate bill and a dashboard showing half of somebody's data.
CREATE FUNCTION "core"."provision_tenant"(
  p_clerk_org_id text,
  p_slug text,
  p_name text,
  p_owner_clerk_user_id text
)
RETURNS TABLE (id uuid, created boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT t.id INTO v_id FROM core.tenants t WHERE t.clerk_org_id = p_clerk_org_id;
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, false;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO core.tenants (slug, name, clerk_org_id, owner_clerk_user_id)
    VALUES (p_slug, p_name, p_clerk_org_id, p_owner_clerk_user_id)
    RETURNING core.tenants.id INTO v_id;
  EXCEPTION
    -- ⚠ TWO DIFFERENT COLLISIONS ARRIVE AS ONE ERROR CODE, AND THEY NEED
    -- OPPOSITE ANSWERS.
    --
    -- A `clerk_org_id` collision means a concurrent delivery won the race and
    -- the tenant now exists — return it, because both deliveries describe the
    -- same organization.
    --
    -- A `slug` collision means some UNRELATED tenant already holds that handle:
    -- a hand-made row, or two Clerk organizations whose names reduce to the same
    -- slug. Failing would be a 500 that Svix retries forever and a customer who
    -- can never sign up, so the handle gets a suffix instead. The slug is a URL,
    -- not an identity — `clerk_org_id` is the identity.
    WHEN unique_violation THEN
      SELECT t.id INTO v_id FROM core.tenants t WHERE t.clerk_org_id = p_clerk_org_id;
      IF v_id IS NOT NULL THEN
        RETURN QUERY SELECT v_id, false;
        RETURN;
      END IF;

      INSERT INTO core.tenants (slug, name, clerk_org_id, owner_clerk_user_id)
      VALUES (
        left(p_slug, 40) || '-' || substr(md5(p_clerk_org_id), 1, 6),
        p_name,
        p_clerk_org_id,
        p_owner_clerk_user_id
      )
      RETURNING core.tenants.id INTO v_id;
  END;

  RETURN QUERY SELECT v_id, true;
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."provision_tenant"(text, text, text, text) TO i10_api;
