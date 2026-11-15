CREATE TABLE "core"."template_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."template_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD COLUMN "from" text;--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD COLUMN "reply_to" text[];--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD COLUMN "preview_text" text;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "from" text;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "reply_to" text[];--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "preview_text" text;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "variables" jsonb;--> statement-breakpoint
ALTER TABLE "core"."template_folders" ADD CONSTRAINT "template_folders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "template_folders_tenant_name_uq" ON "core"."template_folders" USING btree ("tenant_id","name");--> statement-breakpoint
ALTER TABLE "core"."templates" ADD CONSTRAINT "templates_folder_id_template_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "core"."template_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "template_folders_tenant" ON "core"."template_folders" AS PERMISSIVE FOR ALL TO public USING ("core"."template_folders"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."template_folders"."tenant_id" = current_setting('app.tenant_id')::uuid);