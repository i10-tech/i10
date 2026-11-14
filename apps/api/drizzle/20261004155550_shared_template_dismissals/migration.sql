CREATE TABLE "core"."shared_template_dismissals" (
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_template_dismissals_tenant_id_name_pk" PRIMARY KEY("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "core"."shared_template_dismissals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."shared_template_dismissals" ADD CONSTRAINT "shared_template_dismissals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "shared_template_dismissals_tenant" ON "core"."shared_template_dismissals" AS PERMISSIVE FOR ALL TO public USING ("core"."shared_template_dismissals"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."shared_template_dismissals"."tenant_id" = current_setting('app.tenant_id')::uuid);