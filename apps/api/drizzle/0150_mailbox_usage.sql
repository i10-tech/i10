CREATE TABLE "core"."mailbox_usage" (
	"address" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"used_bytes" bigint NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_usage_tenant_id_address_pk" PRIMARY KEY("tenant_id","address")
);
--> statement-breakpoint
ALTER TABLE "core"."mailbox_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."mailbox_usage" ADD CONSTRAINT "mailbox_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "mailbox_usage_workspace" ON "core"."mailbox_usage" AS PERMISSIVE FOR ALL TO public USING ("core"."mailbox_usage"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."mailbox_usage"."tenant_id" = current_setting('app.tenant_id')::uuid);