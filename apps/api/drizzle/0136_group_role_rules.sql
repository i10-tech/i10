CREATE TABLE "identity"."group_role_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"group_value" text NOT NULL,
	"role" text NOT NULL,
	"precedence" integer NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_role_rules_role_check" CHECK ("role" in ('member', 'admin')),
	CONSTRAINT "group_role_rules_precedence_check" CHECK ("precedence" >= 0 and "precedence" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "identity"."group_role_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity"."group_role_rules" ADD CONSTRAINT "group_role_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."group_role_rules" ADD CONSTRAINT "group_role_rules_connection_fk" FOREIGN KEY ("connection_id","tenant_id") REFERENCES "identity"."connections"("id","tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_role_rules_connection_group_unique" ON "identity"."group_role_rules" USING btree ("connection_id","group_value");--> statement-breakpoint
CREATE INDEX "group_role_rules_connection_idx" ON "identity"."group_role_rules" USING btree ("connection_id","precedence");--> statement-breakpoint
CREATE POLICY "group_role_rules_workspace" ON "identity"."group_role_rules" AS PERMISSIVE FOR ALL TO public USING ("identity"."group_role_rules"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("identity"."group_role_rules"."tenant_id" = current_setting('app.tenant_id')::uuid);