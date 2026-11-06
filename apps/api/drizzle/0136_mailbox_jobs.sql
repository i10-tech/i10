CREATE TABLE "core"."mailbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mailbox_address" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"total_messages" integer DEFAULT 0 NOT NULL,
	"processed_messages" integer DEFAULT 0 NOT NULL,
	"total_folders" integer DEFAULT 0 NOT NULL,
	"processed_folders" integer DEFAULT 0 NOT NULL,
	"object_key" text,
	"error" text,
	"error_code" text,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core"."mailbox_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."mailbox_jobs" ADD CONSTRAINT "mailbox_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_jobs_tenant_idx" ON "core"."mailbox_jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "mailbox_jobs_address_idx" ON "core"."mailbox_jobs" USING btree ("mailbox_address");--> statement-breakpoint
CREATE POLICY "mailbox_jobs_workspace" ON "core"."mailbox_jobs" AS PERMISSIVE FOR ALL TO public USING ("core"."mailbox_jobs"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."mailbox_jobs"."tenant_id" = current_setting('app.tenant_id')::uuid);