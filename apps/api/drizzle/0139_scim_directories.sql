CREATE TABLE "identity"."directories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'generic' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directories_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "directories_provider_check" CHECK ("provider" in ('okta', 'entra', 'google', 'generic'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"resource" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_groups_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "directory_groups_id_directory_tenant_unique" UNIQUE("id","directory_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_memberships" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_memberships_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"directory_user_id" uuid NOT NULL,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "directory_outbox_cause_check" CHECK ("cause" in ('created', 'updated', 'deleted', 'group'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "identity"."directory_users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"user_name" text NOT NULL,
	"external_id" text,
	"display_name" text,
	"given_name" text,
	"family_name" text,
	"email" text,
	"active" boolean DEFAULT true NOT NULL,
	"resource" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"clerk_user_id" text,
	"conflict" text,
	"conflict_detail" jsonb,
	"conflict_at" timestamp with time zone,
	"banned_by_directory" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "directory_users_id_tenant_unique" UNIQUE("id","tenant_id"),
	CONSTRAINT "directory_users_id_directory_tenant_unique" UNIQUE("id","directory_id","tenant_id"),
	CONSTRAINT "directory_users_conflict_check" CHECK ("conflict" is null or "conflict" in ('workspace_full', 'blocked', 'banned', 'domain_not_verified', 'address_taken', 'ambiguous_account', 'managed_elsewhere', 'role_exempt', 'already_linked', 'no_email', 'profile_incomplete', 'last_owner', 'account_deleted', 'no_sso_connection'))
);
--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity"."directories" ADD CONSTRAINT "directories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ADD CONSTRAINT "directory_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_groups" ADD CONSTRAINT "directory_groups_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ADD CONSTRAINT "directory_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ADD CONSTRAINT "directory_memberships_group_fk" FOREIGN KEY ("group_id","directory_id","tenant_id") REFERENCES "identity"."directory_groups"("id","directory_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_memberships" ADD CONSTRAINT "directory_memberships_user_fk" FOREIGN KEY ("user_id","directory_id","tenant_id") REFERENCES "identity"."directory_users"("id","directory_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_outbox" ADD CONSTRAINT "directory_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_outbox" ADD CONSTRAINT "directory_outbox_user_fk" FOREIGN KEY ("directory_user_id","directory_id","tenant_id") REFERENCES "identity"."directory_users"("id","directory_id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_tokens" ADD CONSTRAINT "directory_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_tokens" ADD CONSTRAINT "directory_tokens_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ADD CONSTRAINT "directory_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."directory_users" ADD CONSTRAINT "directory_users_directory_fk" FOREIGN KEY ("directory_id","tenant_id") REFERENCES "identity"."directories"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directories_tenant_idx" ON "identity"."directories" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "directory_groups_directory_idx" ON "identity"."directory_groups" USING btree ("directory_id","display_name");--> statement-breakpoint
CREATE INDEX "directory_memberships_user_idx" ON "identity"."directory_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "directory_outbox_pending_idx" ON "identity"."directory_outbox" USING btree ("tenant_id","directory_id","created_at") WHERE "identity"."directory_outbox"."applied_at" is null;--> statement-breakpoint
CREATE INDEX "directory_outbox_user_idx" ON "identity"."directory_outbox" USING btree ("directory_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_tokens_hash_unique" ON "identity"."directory_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "directory_tokens_directory_idx" ON "identity"."directory_tokens" USING btree ("directory_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_users_user_name_unique" ON "identity"."directory_users" USING btree ("directory_id",lower("user_name")) WHERE "identity"."directory_users"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_users_clerk_user_unique" ON "identity"."directory_users" USING btree ("directory_id","clerk_user_id") WHERE "identity"."directory_users"."deleted_at" is null and "identity"."directory_users"."clerk_user_id" is not null;--> statement-breakpoint
CREATE INDEX "directory_users_tenant_user_idx" ON "identity"."directory_users" USING btree ("tenant_id","clerk_user_id");--> statement-breakpoint
CREATE INDEX "directory_users_external_idx" ON "identity"."directory_users" USING btree ("directory_id","external_id");--> statement-breakpoint
CREATE INDEX "directory_users_email_idx" ON "identity"."directory_users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE POLICY "directories_workspace" ON "identity"."directories" AS PERMISSIVE FOR ALL TO public USING ("identity"."directories"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directories"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_groups_workspace" ON "identity"."directory_groups" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_groups"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_groups"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_memberships_workspace" ON "identity"."directory_memberships" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_memberships"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_memberships"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_outbox_workspace" ON "identity"."directory_outbox" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_outbox"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_outbox"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_tokens_workspace" ON "identity"."directory_tokens" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_tokens"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_tokens"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "directory_tokens_hash_read" ON "identity"."directory_tokens" AS PERMISSIVE FOR SELECT TO public USING ("identity"."directory_tokens"."token_hash" = nullif(current_setting('app.scim_token', true), ''));--> statement-breakpoint
CREATE POLICY "directory_users_workspace" ON "identity"."directory_users" AS PERMISSIVE FOR ALL TO public USING ("identity"."directory_users"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."directory_users"."tenant_id" = current_setting('app.tenant_id')::uuid);