CREATE TABLE "core"."mailbox_deletions" (
	"tenant_id" uuid,
	"clerk_user_id" text,
	"address" text NOT NULL,
	"outcome" text NOT NULL,
	"forward_user_id" text,
	"forward_address" text,
	"requested_by" text NOT NULL,
	"deleting_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_deletions_pkey" PRIMARY KEY("tenant_id","clerk_user_id"),
	CONSTRAINT "mailbox_deletions_outcome_check" CHECK ("outcome" in ('delete', 'export_then_delete', 'forward')),
	CONSTRAINT "mailbox_deletions_forward_check" CHECK ((("outcome" = 'forward') = ("forward_user_id" is not null)) and (("outcome" = 'forward') = ("forward_address" is not null))),
	CONSTRAINT "mailbox_deletions_due_check" CHECK ("purge_after" >= "deleting_at")
);
--> statement-breakpoint
ALTER TABLE "core"."mailbox_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "deleting_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "accounts_deleting_idx" ON "authd"."accounts" ("deleting_at") WHERE "deleting_at" is not null;--> statement-breakpoint
CREATE INDEX "mailbox_deletions_forward_idx" ON "core"."mailbox_deletions" ("tenant_id","forward_user_id") WHERE "forward_user_id" is not null;--> statement-breakpoint
ALTER TABLE "core"."mailbox_deletions" ADD CONSTRAINT "mailbox_deletions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "mailbox_deletions_workspace" ON "core"."mailbox_deletions" AS PERMISSIVE FOR ALL TO public USING ("core"."mailbox_deletions"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."mailbox_deletions"."tenant_id" = current_setting('app.tenant_id')::uuid);