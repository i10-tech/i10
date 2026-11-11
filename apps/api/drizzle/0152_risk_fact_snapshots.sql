CREATE TABLE "core"."risk_fact_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"ruleset_version" integer NOT NULL,
	"trigger" text NOT NULL,
	"score" integer NOT NULL,
	"band" "core"."risk_band" NOT NULL,
	"contributions" jsonb NOT NULL,
	"shadow" jsonb NOT NULL,
	"facts" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."risk_fact_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."risk_assessment_events" ADD COLUMN "shadow" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."risk_assessments" ADD COLUMN "shadow" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."risk_fact_snapshots" ADD CONSTRAINT "risk_fact_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_fact_snapshots_tenant_idx" ON "core"."risk_fact_snapshots" USING btree ("tenant_id","taken_at");--> statement-breakpoint
CREATE INDEX "risk_fact_snapshots_time_idx" ON "core"."risk_fact_snapshots" USING btree ("taken_at","id");--> statement-breakpoint
CREATE POLICY "risk_fact_snapshots_deny" ON "core"."risk_fact_snapshots" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);