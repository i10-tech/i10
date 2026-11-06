CREATE TABLE "core"."mailbox_auth_failures" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"account" text NOT NULL,
	"ip" text,
	"subnet" text,
	"listener" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."mailbox_auth_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."mailbox_auth_failures" ADD CONSTRAINT "mailbox_auth_failures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_auth_failures_account_idx" ON "core"."mailbox_auth_failures" USING btree ("tenant_id","account","occurred_at");--> statement-breakpoint
CREATE POLICY "mailbox_auth_failures_tenant" ON "core"."mailbox_auth_failures" AS PERMISSIVE FOR ALL TO public USING ("core"."mailbox_auth_failures"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."mailbox_auth_failures"."tenant_id" = current_setting('app.tenant_id')::uuid);