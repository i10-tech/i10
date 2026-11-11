CREATE TABLE "core"."mailbox_usage" (
	"address" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"used_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."mailbox_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."mailbox_usage" ADD CONSTRAINT "mailbox_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_usage_tenant_idx" ON "core"."mailbox_usage" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "mailbox_usage_workspace" ON "core"."mailbox_usage" AS PERMISSIVE FOR ALL TO public USING ("core"."mailbox_usage"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."mailbox_usage"."tenant_id" = current_setting('app.tenant_id')::uuid);