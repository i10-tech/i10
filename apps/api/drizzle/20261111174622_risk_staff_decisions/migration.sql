CREATE TYPE "core"."risk_decision_kind" AS ENUM('release', 'pin', 'uphold', 'hold');--> statement-breakpoint
CREATE TABLE "core"."risk_staff_decisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "core"."risk_decision_kind" NOT NULL,
	"decided_by" text NOT NULL,
	"note" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"score" integer NOT NULL,
	"band" "core"."risk_band" NOT NULL,
	"ruleset_version" integer NOT NULL,
	"held" boolean NOT NULL,
	"in_view" jsonb NOT NULL,
	"covers" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"snapshot_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoke_note" text
);
--> statement-breakpoint
ALTER TABLE "core"."risk_staff_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."risk_assessment_events" ADD COLUMN "cleared" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."risk_assessments" ADD COLUMN "cleared" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."risk_fact_snapshots" ADD COLUMN "cleared" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."risk_staff_decisions" ADD CONSTRAINT "risk_staff_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."risk_staff_decisions" ADD CONSTRAINT "risk_staff_decisions_snapshot_id_risk_fact_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "core"."risk_fact_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_staff_decisions_tenant_idx" ON "core"."risk_staff_decisions" USING btree ("tenant_id","decided_at");--> statement-breakpoint
CREATE INDEX "risk_staff_decisions_snapshot_idx" ON "core"."risk_staff_decisions" USING btree ("snapshot_id");--> statement-breakpoint
CREATE POLICY "risk_staff_decisions_deny" ON "core"."risk_staff_decisions" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);