CREATE TYPE "core"."ses_finding_impact" AS ENUM('high', 'low');--> statement-breakpoint
CREATE TABLE "core"."ses_reputation_findings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"impact" "core"."ses_finding_impact" NOT NULL,
	"description" text,
	"opened_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"source" text NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."ses_reputation_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."ses_reputation_snapshots" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sending_status" "core"."ses_sending_status",
	"impact" "core"."ses_finding_impact",
	"policy" text,
	"sends_24h" integer NOT NULL,
	"hard_bounces_24h" integer NOT NULL,
	"soft_bounces_24h" integer NOT NULL,
	"complaints_24h" integer NOT NULL,
	"sends_7d" integer NOT NULL,
	"hard_bounces_7d" integer NOT NULL,
	"soft_bounces_7d" integer NOT NULL,
	"complaints_7d" integer NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ses_reputation_snapshots_tenant_id_day_pk" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
ALTER TABLE "core"."ses_reputation_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."ses_reputation_findings" ADD CONSTRAINT "ses_reputation_findings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ses_reputation_snapshots" ADD CONSTRAINT "ses_reputation_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ses_reputation_findings_open_unique" ON "core"."ses_reputation_findings" USING btree ("tenant_id","type","impact") WHERE "core"."ses_reputation_findings"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "ses_reputation_findings_tenant_idx" ON "core"."ses_reputation_findings" USING btree ("tenant_id","opened_at");--> statement-breakpoint
CREATE POLICY "ses_reputation_findings_tenant" ON "core"."ses_reputation_findings" AS PERMISSIVE FOR ALL TO public USING ("core"."ses_reputation_findings"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."ses_reputation_findings"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "ses_reputation_snapshots_tenant" ON "core"."ses_reputation_snapshots" AS PERMISSIVE FOR ALL TO public USING ("core"."ses_reputation_snapshots"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."ses_reputation_snapshots"."tenant_id" = current_setting('app.tenant_id')::uuid);