CREATE TABLE "core"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"polar_subscription_id" text NOT NULL,
	"polar_customer_id" text NOT NULL,
	"polar_product_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" text NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_end" timestamp with time zone,
	"event_at" timestamp with time zone NOT NULL,
	"granted_plan_id" text,
	"granted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "subscriptions_polar_subscription_id_unique" UNIQUE("polar_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "core"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscriptions_granted_idx" ON "core"."subscriptions" USING btree ("granted_plan_id","plan_id");--> statement-breakpoint
-- Row level security for the subscription table.
--
-- ⚠ A NEW TABLE IN `core` IS NOT PROTECTED UNTIL THIS RUNS, AND NOTHING FAILS
-- WHILE IT IS NOT. Grants come free from the ALTER DEFAULT PRIVILEGES in 0002;
-- policies do not. Without this every tenant can read — and write — every other
-- tenant's plan, and the only symptom is a customer seeing somebody else's
-- subscription in their console.
ALTER TABLE "core"."subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "core"."subscriptions"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint
-- Every tenant's plan, in one row per tenant, for the reconciler.
--
-- ⚠ THE RECONCILER ASKS A QUESTION NO TENANT-SCOPED CONNECTION CAN ANSWER. It
-- compares our entitlements against Polar's list of subscriptions, which spans
-- every tenant at once; under the policy above, `i10_api` sees exactly one row
-- and would conclude that every other customer's subscription had vanished —
-- and the reconciler's job is to act on discrepancies.
--
-- Same shape as `sweep_stuck_messages` and `message_owner`, and held to the same
-- rule: one narrow question, answered by the owner, returning the minimum. It
-- exposes no addresses, no message content and no Polar customer id — only what
-- plan each tenant should hold and what they were last granted, which is the
-- comparison and nothing more.
--
-- ⚠ AND IT IS `STABLE`, NOT `VOLATILE`, so it can be planned as a scan rather
-- than re-executed per output row.
CREATE FUNCTION "core"."subscriptions_snapshot"()
RETURNS TABLE (
  tenant_id uuid,
  polar_subscription_id text,
  plan_id text,
  status text,
  granted_plan_id text,
  event_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT s.tenant_id, s.polar_subscription_id, s.plan_id, s.status,
         s.granted_plan_id, s.event_at
    FROM core.subscriptions s
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."subscriptions_snapshot"() TO i10_api;
