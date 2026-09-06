CREATE TYPE "core"."plan_source" AS ENUM('catalog', 'custom');--> statement-breakpoint
CREATE TABLE "core"."meter_events" (
	"tenant_id" uuid NOT NULL,
	"feature_id" text NOT NULL,
	"event_id" text NOT NULL,
	"shard" integer DEFAULT 0 NOT NULL,
	"value" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meter_events_tenant_id_feature_id_event_id_pk" PRIMARY KEY("tenant_id","feature_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "core"."plan_assignments" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"anchor" timestamp with time zone NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."plans" (
	"id" text PRIMARY KEY NOT NULL,
	"source" "core"."plan_source" NOT NULL,
	"tenant_id" uuid,
	"name" text NOT NULL,
	"entitlements" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."meter_events" ADD CONSTRAINT "meter_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."plan_assignments" ADD CONSTRAINT "plan_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."plan_assignments" ADD CONSTRAINT "plan_assignments_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "core"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."plans" ADD CONSTRAINT "plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meter_events_window_idx" ON "core"."meter_events" USING btree ("tenant_id","feature_id","shard","occurred_at");--> statement-breakpoint
CREATE INDEX "plans_tenant_idx" ON "core"."plans" USING btree ("tenant_id");--> statement-breakpoint

-- ⚠ THE TWO WAYS A PLAN CAN BE MISFILED ARE BOTH SILENT, SO THE DATABASE
-- REFUSES THEM. A `custom` plan with no owner is invisible to the tenant it was
-- built for — it fails the policy below and reads as "no such plan". A
-- `catalog` plan with an owner is a price list only one customer can see. The
-- discriminator and the owner column have to agree, and neither is a comment.
ALTER TABLE "core"."plans" ADD CONSTRAINT "plans_source_owner_ck"
  CHECK (("source" = 'catalog') = ("tenant_id" IS NULL));
--> statement-breakpoint

-- Row level security for the three metering tables.
--
-- ⚠ A NEW TABLE IN `core` IS NOT PROTECTED UNTIL THIS RUNS, AND NOTHING FAILS
-- WHILE IT IS NOT. Grants arrive free from the ALTER DEFAULT PRIVILEGES in
-- 0002; policies do not. Without these, every tenant can read — and write —
-- every other tenant's usage, and the only symptom is a number that is too big.
ALTER TABLE "core"."meter_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "core"."meter_events"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint

ALTER TABLE "core"."plan_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "core"."plan_assignments"
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint

-- ⚠ THE ONLY POLICY IN `core` THAT IS NOT A PLAIN EQUALITY, AND THE ASYMMETRY
-- IS THE WHOLE DESIGN.
--
-- READ: a catalogue plan has `tenant_id IS NULL` and is visible to everyone —
-- it is the price list, and it is on the website. A custom plan is visible only
-- to the tenant it was built for, because NULL never equals anything and the
-- equality does the rest.
--
-- WRITE: the WITH CHECK deliberately OMITS the NULL branch. `i10_api` can
-- therefore create and edit a bespoke plan for the tenant it is scoped to, and
-- can NEVER create or alter a catalogue one — those belong to the owner role,
-- which is what runs migrations and the config push. That is the position
-- already taken in infra/autumn/autumn.config.ts ("the dashboard is not the
-- source of truth, this file is"), enforced by the database instead of by
-- reviewers.
--
-- ⚠ AND IT IS STILL STRICT `current_setting`, WITHOUT missing_ok. The function
-- is STABLE, so it is evaluated once per query before any row is examined —
-- an unset tenant context raises here exactly as it does everywhere else in
-- `core`, rather than quietly degrading to "catalogue only" and looking like a
-- tenant with no custom plan.
ALTER TABLE "core"."plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "core"."plans"
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint

-- The catalogue, seeded to match infra/autumn/autumn.config.ts exactly.
--
-- ⚠ THE FREE PLAN HAS TO EXIST BEFORE THE FIRST SIGNUP, AND THAT IS THE WHOLE
-- REASON THIS IS IN THE MIGRATION RATHER THAN IN A JOB. A tenant assigned a
-- plan id that is not here has no entitlement at all — which reads to the
-- customer as an outage and to us as a misconfiguration nobody notices until a
-- send is refused. The same warning is written on Autumn's config file.
--
-- ⚠ AND THE DAILY RESET ON `free` IS DELIBERATE, NOT A SMALLER MONTH. A monthly
-- free allowance is a customer who exhausts it on day one and cannot evaluate
-- the product until next month.
--
-- DO NOTHING rather than DO UPDATE: reconciling the catalogue is the config
-- push's job, and a migration that silently reverted a deliberate change would
-- be a second source of truth.
INSERT INTO core.plans (id, source, tenant_id, name, entitlements) VALUES
  ('free', 'catalog', NULL, 'Free',
   '[{"featureId":"emails","allowance":100,"interval":"day"}]'::jsonb),
  ('pro', 'catalog', NULL, 'Pro',
   '[{"featureId":"emails","allowance":50000,"interval":"month"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- Every tenant that already exists, put on the plan they already hold.
--
-- ⚠ WITHOUT THIS, TURNING THE NEW METER ON MAKES EVERY EXISTING TENANT
-- `unentitled`. There is no row to find, so no allowance resolves, and the
-- correct-looking answer is the wrong one for every customer at once.
--
-- The plan comes from `subscriptions.granted_plan_id` — what we last actually
-- entitled them to, rather than what they bought — falling back to `free` for
-- tenants with no subscription row, which is all of them until somebody pays.
--
-- ⚠ THE ANCHOR IS `tenants.created_at`, WHICH IS THE HONEST ANSWER AND NOT A
-- CONVENIENCE. It is when their metering actually began; using `now()` would
-- restart every customer's window at deploy time, handing everyone a fresh
-- allowance on the day of the migration and moving every boundary afterwards.
--
-- The IN clause guards the foreign key: a `granted_plan_id` that is not in the
-- catalogue leaves that tenant unassigned and visible, rather than failing the
-- whole migration on one bad row.
INSERT INTO core.plan_assignments (tenant_id, plan_id, anchor)
SELECT t.id, COALESCE(s.granted_plan_id, 'free'), t.created_at
  FROM core.tenants t
  LEFT JOIN core.subscriptions s ON s.tenant_id = t.id
 WHERE COALESCE(s.granted_plan_id, 'free') IN (SELECT p.id FROM core.plans p)
ON CONFLICT (tenant_id) DO NOTHING;
