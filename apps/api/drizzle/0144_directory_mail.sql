CREATE TABLE "identity"."directory_mailboxes" (
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"address" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"next" text DEFAULT 'keep' NOT NULL,
	"target_user_id" text,
	"delete_after_days" integer,
	"delete_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_mailboxes_tenant_id_clerk_user_id_pk" PRIMARY KEY("tenant_id","clerk_user_id"),
	CONSTRAINT "directory_mailboxes_state_check" CHECK ("state" in ('active', 'suspended')),
	CONSTRAINT "directory_mailboxes_next_check" CHECK ("next" in ('keep', 'forward_manager', 'delegate', 'delete')),
	CONSTRAINT "directory_mailboxes_target_check" CHECK ((("next" in ('forward_manager', 'delegate')) = ("target_user_id" is not null))),
	CONSTRAINT "directory_mailboxes_delete_check" CHECK ((("next" = 'delete') = ("delete_at" is not null)) and (("next" = 'delete') = ("delete_after_days" is not null)) and ("delete_after_days" is null or "delete_after_days" between 7 and 365)),
	CONSTRAINT "directory_mailboxes_suspended_check" CHECK (("state" = 'suspended') = ("suspended_at" is not null) and ("state" = 'suspended' or "next" = 'keep'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_mailboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authd"."aliases" ADD COLUMN "source" text DEFAULT 'clerk' NOT NULL;--> statement-breakpoint
ALTER TABLE "authd"."groups" ADD COLUMN "directory_group_id" uuid;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD COLUMN "create_mailboxes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ADD COLUMN "mail_address" text;--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ADD COLUMN "mail_kind" text;--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ADD COLUMN "aliases_ignored" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ADD COLUMN "mailbox_note" text;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "leaver_action" text DEFAULT 'keep' NOT NULL;--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD COLUMN "leaver_days" integer;--> statement-breakpoint
ALTER TABLE "identity"."directory_mailboxes" ADD CONSTRAINT "directory_mailboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_mailboxes_due_idx" ON "identity"."directory_mailboxes" USING btree ("tenant_id","delete_at") WHERE "identity"."directory_mailboxes"."delete_at" is not null;--> statement-breakpoint
ALTER TABLE "authd"."groups" ADD CONSTRAINT "authd_groups_directory_group_fk" FOREIGN KEY ("directory_group_id") REFERENCES "identity"."directory_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_groups_mail_address_unique" ON "identity"."directory_groups" USING btree (lower("mail_address")) WHERE "identity"."directory_groups"."mail_address" is not null;--> statement-breakpoint
ALTER TABLE "authd"."aliases" ADD CONSTRAINT "aliases_source_check" CHECK ("source" in ('clerk', 'directory'));--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ADD CONSTRAINT "directory_groups_mail_check" CHECK (("mail_address" is null) = ("mail_kind" is null) and ("mail_kind" is null or "mail_kind" in ('list', 'shared')));--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ADD CONSTRAINT "directory_users_mailbox_note_check" CHECK ("mailbox_note" is null or "mailbox_note" in ('domain_not_hosted', 'limit', 'address_taken'));--> statement-breakpoint
ALTER TABLE "identity"."workspace_settings" ADD CONSTRAINT "workspace_settings_leaver_check" CHECK ("leaver_action" in ('keep', 'forward_manager', 'delete_after') and (("leaver_action" = 'delete_after') = ("leaver_days" is not null)) and ("leaver_days" is null or "leaver_days" between 7 and 365));--> statement-breakpoint
CREATE POLICY "directory_mailboxes_workspace" ON "identity"."directory_mailboxes" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_mailboxes"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_mailboxes"."tenant_id" = current_setting('app.tenant_id')::uuid);