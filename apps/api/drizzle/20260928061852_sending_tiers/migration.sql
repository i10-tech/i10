CREATE TYPE "core"."sending_tier" AS ENUM('strict', 'normal');--> statement-breakpoint
CREATE TABLE "core"."sending_tier_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_tier" "core"."sending_tier" NOT NULL,
	"to_tier" "core"."sending_tier" NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."sending_tier_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."sending_tiers" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"tier" "core"."sending_tier" NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"set_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."sending_tiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."sending_tier_events" ADD CONSTRAINT "sending_tier_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."sending_tiers" ADD CONSTRAINT "sending_tiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sending_tier_events_tenant_idx" ON "core"."sending_tier_events" USING btree ("tenant_id","changed_at");--> statement-breakpoint
CREATE POLICY "sending_tier_events_tenant" ON "core"."sending_tier_events" AS PERMISSIVE FOR ALL TO public USING ("core"."sending_tier_events"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."sending_tier_events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "sending_tiers_tenant" ON "core"."sending_tiers" AS PERMISSIVE FOR ALL TO public USING ("core"."sending_tiers"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."sending_tiers"."tenant_id" = current_setting('app.tenant_id')::uuid);