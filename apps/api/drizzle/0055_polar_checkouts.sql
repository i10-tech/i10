-- Which workspace a Polar checkout was started for.
--
-- ⚠ THIS EXISTS TO GET WORKSPACE IDENTITY OUT OF POLAR ENTIRELY, which is the
-- root of every attribution bug this system has had. `external_customer_id` put
-- a TENANT id into a field Polar scopes to a PERSON and deduplicates by EMAIL —
-- and those have different lifetimes. A workspace is deleted; the person is not.
-- So the customer is reused on their next signup still naming the workspace they
-- deleted, and because the field is IMMUTABLE once set (verified: `422 Customer
-- external ID cannot be updated`) nothing can ever repair it.
--
-- ⚠ THE CHECKOUT IS THE RIGHT CARRIER BECAUSE WE CREATE IT AND IT IS PER
-- PURCHASE. One checkout buys one subscription for one workspace, and
-- `subscription.checkout_id` is on every subscription Polar returns — so the
-- whole question "whose is this" is answered by a row we wrote ourselves,
-- before the customer was redirected, from an authenticated session.
--
-- ⚠ AND IT REPLACES `metadata.tenant_id` RATHER THAN JOINING IT. Metadata is
-- round-tripped through Polar and editable from their dashboard; this is not
-- reachable from outside this database at all. The old path stays readable for
-- the checkouts that predate this table and for nothing else.
CREATE TABLE "core"."polar_checkouts" (
    "polar_checkout_id" text NOT NULL,
    "tenant_id" uuid NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT "polar_checkouts_pkey" PRIMARY KEY ("polar_checkout_id"),
    -- ⚠ NO CASCADE TO A DELETED WORKSPACE, BECAUSE TERMINATION DOES NOT DELETE
    -- THE ROW. `terminate_tenant` marks the tenant dead and leaves it standing,
    -- so this keeps pointing at a tenant that exists and is closed — which is
    -- exactly what a later event for that subscription needs to resolve to.
    CONSTRAINT "polar_checkouts_tenant_id_tenants_id_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE CASCADE
);
--> statement-breakpoint

-- The write happens inside an authenticated, tenant-scoped request, so it goes
-- through the ordinary policy like every other write in this schema.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE core.polar_checkouts ENABLE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON core.polar_checkouts '
    'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
    'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)';
END $$;
--> statement-breakpoint

-- The read, which is the half no policy can serve.
--
-- ⚠ SECURITY DEFINER BECAUSE THE READER HAS NO TENANT. A Polar webhook arrives
-- unauthenticated and is asking precisely "whose is this" — there is no
-- `app.tenant_id` to set, and setting the one the payload claims would be
-- assuming the answer. Same shape as `subscription_owner` and `tenants_known`:
-- one narrow question, answered by the owner, returning the minimum.
CREATE FUNCTION "core"."checkout_tenant"(
  p_polar_checkout_id text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT c.tenant_id
    FROM core.polar_checkouts c
   WHERE c.polar_checkout_id = p_polar_checkout_id;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."checkout_tenant"(text) TO i10_api;
