CREATE TABLE "core"."workspace_roles" (
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text NOT NULL,
	"role" text NOT NULL,
	"clerk_membership_id" text,
	"source" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_roles_tenant_id_clerk_user_id_pk" PRIMARY KEY("tenant_id","clerk_user_id"),
	CONSTRAINT "workspace_roles_role_check" CHECK ("role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "core"."workspace_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."workspace_roles" ADD CONSTRAINT "workspace_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_roles_tenant_role_idx" ON "core"."workspace_roles" USING btree ("tenant_id","role");--> statement-breakpoint
CREATE POLICY "workspace_roles_workspace" ON "core"."workspace_roles" AS PERMISSIVE FOR ALL TO public USING ("core"."workspace_roles"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."workspace_roles"."tenant_id" = current_setting('app.tenant_id')::uuid);