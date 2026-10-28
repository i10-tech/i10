ALTER TYPE "core"."webhook_event_type" ADD VALUE 'member.provisioned';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'member.deprovisioned';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'sso.connection.failed';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'sso.certificate.expiring';--> statement-breakpoint
CREATE TABLE "identity"."siem_exports" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"region" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_hint" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_event_id" uuid,
	"last_export_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity"."siem_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity"."siem_exports" ADD CONSTRAINT "siem_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_connection_type_idx" ON "identity"."events" USING btree ("tenant_id","connection_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_tenant_id_idx" ON "identity"."events" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE POLICY "siem_exports_workspace" ON "identity"."siem_exports" AS PERMISSIVE FOR ALL TO public USING ("identity"."siem_exports"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."siem_exports"."tenant_id" = current_setting('app.tenant_id')::uuid);