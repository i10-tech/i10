CREATE TYPE "core"."ses_sending_status" AS ENUM('enabled', 'disabled', 'reinstated');--> statement-breakpoint
CREATE TABLE "core"."ses_tenant_status" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"status" "core"."ses_sending_status" NOT NULL,
	"cause" text,
	"origin" text,
	"changed_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."ses_tenant_status" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."ses_tenant_status_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "core"."ses_sending_status" NOT NULL,
	"cause" text,
	"origin" text,
	"changed_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."ses_tenant_status_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."ses_tenant_status" ADD CONSTRAINT "ses_tenant_status_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ses_tenant_status_events" ADD CONSTRAINT "ses_tenant_status_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ses_tenant_status_events_change_unique" ON "core"."ses_tenant_status_events" USING btree ("tenant_id","status","changed_at");--> statement-breakpoint
CREATE INDEX "ses_tenant_status_events_tenant_idx" ON "core"."ses_tenant_status_events" USING btree ("tenant_id","changed_at");--> statement-breakpoint
CREATE POLICY "ses_tenant_status_tenant" ON "core"."ses_tenant_status" AS PERMISSIVE FOR ALL TO public USING ("core"."ses_tenant_status"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."ses_tenant_status"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "ses_tenant_status_events_tenant" ON "core"."ses_tenant_status_events" AS PERMISSIVE FOR ALL TO public USING ("core"."ses_tenant_status_events"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."ses_tenant_status_events"."tenant_id" = current_setting('app.tenant_id')::uuid);