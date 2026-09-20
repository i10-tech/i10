-- Ending a tenant, and telling a dead tenant id from a live one.
--
-- ⚠ ALL THREE FUNCTIONS EXIST BECAUSE THE QUESTION IS ASKED FROM OUTSIDE ANY
-- TENANT'S SCOPE. `core.tenants` is protected by
-- `id = current_setting('app.tenant_id')`, so `i10_api` can only ever see the
-- one tenant a request is scoped to — and a Clerk `organization.deleted`
-- webhook carries an organization id, not a tenant id, while a Polar customer
-- carries a tenant id belonging to somebody who may no longer exist. Same shape
-- as `provision_tenant`, `subscriptions_snapshot` and `message_owner`, and held
-- to the same rule: one narrow question, answered by the owner, returning the
-- minimum.

-- Is this tenant id one that still exists and is still live?
--
-- ⚠ THE ONE QUESTION THAT DECIDES WHETHER A RE-SIGN-UP CAN EVER BE PAID FOR,
-- AND IT RETURNS A BOOLEAN BECAUSE THAT IS ALL THE CALLER MAY HAVE. Polar
-- deduplicates customers by email: somebody who subscribed, deleted their
-- account and signed up again is handed back the SAME Polar customer, still
-- carrying the FIRST tenant's `external_id`. `routes/checkout-status.ts` has to
-- decide between two readings of that — a collision between two live workspaces,
-- where overwriting would move somebody else's billing onto this one, and a
-- tenant that is gone, where refusing to overwrite means the payment can never
-- be attributed to anybody, for ever. The difference is exactly this boolean.
--
-- ⚠ IT TAKES `text` AND CASTS DEFENSIVELY. The value arrives from a Polar
-- customer record, which is to say from outside; `uuid` in the signature would
-- make a customer carrying a non-uuid `external_id` an invalid_text_
-- representation error inside a status poll a customer is watching, rather than
-- the `false` that it means.
--
-- ⚠ AND `suspended` IS NOT LIVE FOR THIS PURPOSE, DELIBERATELY. Suspension is a
-- billing decision about a tenant that still exists and whose owner can still
-- sign in — its Polar customer is still theirs, and handing it to somebody else
-- would be the same mistake as the collision case. Only `active` is live.
CREATE FUNCTION "core"."tenant_is_live"(p_tenant_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  BEGIN
    v_id := p_tenant_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  RETURN EXISTS (
    SELECT 1 FROM core.tenants t WHERE t.id = v_id AND t.status = 'active'
  );
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."tenant_is_live"(text) TO i10_api;
--> statement-breakpoint

-- Mark a tenant dead, and hand back what still has to be switched off elsewhere.
--
-- ⚠ IT MARKS RATHER THAN DELETES, AND THE FOREIGN KEYS ARE THE REASON. Every
-- tenant-scoped table cascades from `core.tenants`, so a DELETE here destroys
-- the message history a customer may be legally required to retain and the
-- subscription row that records what they were last charged for. `status`
-- already has a `deleted` member for exactly this; retention and export are a
-- separate decision, taken by a human, on data that still exists.
--
-- ⚠ IT RETURNS THE POLAR SUBSCRIPTION ID BECAUSE THE CALLER CANNOT READ IT
-- EITHER. `core.subscriptions` carries the same policy as `core.tenants`, and
-- the caller is a webhook that has never been scoped to this tenant and — the
-- tenant now being dead — never will be.
--
-- ⚠ AND IT IS IDEMPOTENT, ANSWERING `already_dead` RATHER THAN NOTHING. Svix
-- redelivers; a second delivery must not read as "no such organization", which
-- is the answer that would have the caller log a missing tenant instead of
-- acknowledging a duplicate.
CREATE FUNCTION "core"."terminate_tenant"(
  p_clerk_org_id text,
  p_free_plan_id text
)
RETURNS TABLE (
  tenant_id uuid,
  polar_subscription_id text,
  already_dead boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_was text;
  v_sub text;
BEGIN
  SELECT t.id, t.status INTO v_id, v_was
    FROM core.tenants t
   WHERE t.clerk_org_id = p_clerk_org_id;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE core.tenants
     SET status = 'deleted', updated_at = now()
   WHERE id = v_id;

  SELECT s.polar_subscription_id INTO v_sub
    FROM core.subscriptions s
   WHERE s.tenant_id = v_id;

  -- ⚠ THE ENTITLEMENT IS MOVED HERE AS WELL AS IN THE APPLICATION, AND THAT IS
  -- NOT BELT AND BRACES. `plan_assignments` is what the send path reads; a
  -- tenant marked dead while still assigned to a paid plan would keep its
  -- allowance until something else noticed, and the thing that usually notices
  -- is a customer. Doing it in the same statement as the status change means
  -- there is no window where the two disagree.
  UPDATE core.plan_assignments
     SET plan_id = p_free_plan_id, updated_at = now()
   WHERE plan_assignments.tenant_id = v_id
     AND plan_assignments.plan_id <> p_free_plan_id;

  -- ⚠ AND THE SUBSCRIPTION ROW IS MARKED GRANTED-TO-FREE SO THE RECONCILER
  -- AGREES WITH US. It compares `granted_plan_id` against what Polar's
  -- subscription entitles; leaving `pro` here would make every half-hourly run
  -- find a discrepancy and "repair" it by re-granting a plan to a workspace
  -- that no longer exists.
  UPDATE core.subscriptions
     SET granted_plan_id = p_free_plan_id,
         granted_at      = now(),
         updated_at      = now()
   WHERE subscriptions.tenant_id = v_id;

  RETURN QUERY SELECT v_id, v_sub, (v_was = 'deleted');
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."terminate_tenant"(text, text) TO i10_api;
--> statement-breakpoint

-- The tenants one person owns, for the `user.deleted` sweep.
--
-- ⚠ IT EXISTS BECAUSE CLERK'S CASCADE IS NOT SOMETHING WE CAN ASSERT. Deleting
-- a user in Clerk may or may not fire `organization.deleted` for the personal
-- organization that user was the only member of — the behaviour is not stated
-- anywhere we can point at, and the failure mode if it does not fire is a
-- subscription that bills a person who deleted their account. This is what lets
-- `user.deleted` ask Clerk directly whether each organization still exists,
-- rather than guessing.
--
-- ⚠ AND IT RETURNS ORGANIZATION IDS, NOT A LICENCE TO TERMINATE. The caller
-- must still confirm with Clerk that the organization is gone before calling
-- `terminate_tenant`; a team whose owner deleted their own account is a tenant
-- with other people still using it.
CREATE FUNCTION "core"."tenants_owned_by"(p_owner_clerk_user_id text)
RETURNS TABLE (
  tenant_id uuid,
  clerk_org_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT t.id, t.clerk_org_id
    FROM core.tenants t
   WHERE t.owner_clerk_user_id = p_owner_clerk_user_id
     AND t.status = 'active'
     AND t.clerk_org_id IS NOT NULL
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."tenants_owned_by"(text) TO i10_api;
--> statement-breakpoint

-- What a deferred plan change is waiting to become.
--
-- ⚠ POLAR APPLIES A `next_period` CHANGE AT THE PERIOD BOUNDARY AND NOT BEFORE,
-- which is the whole reason downgrades are requested that way — the customer
-- keeps what they paid for. The consequence is that `product_id` still names the
-- OLD plan for the rest of the period, so nothing in our copy of the
-- subscription could say a change had been accepted at all. A customer who
-- downgraded saw "Pro — renews on the 4th" and no other acknowledgement, which
-- reads exactly like a button that did nothing.
--
-- Polar states it on the subscription as `pending_update`, with `product_id` and
-- `applies_at`; these two columns are that, mapped through our product map.
ALTER TABLE "core"."subscriptions" ADD COLUMN "scheduled_plan_id" text;--> statement-breakpoint
ALTER TABLE "core"."subscriptions" ADD COLUMN "scheduled_at" timestamp with time zone;
