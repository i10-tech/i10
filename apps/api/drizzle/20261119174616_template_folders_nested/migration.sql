DROP INDEX "core"."template_folders_tenant_name_uq";--> statement-breakpoint
ALTER TABLE "core"."template_folders" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."template_folders" ADD CONSTRAINT "template_folders_tenant_parent_name_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","parent_id","name");--> statement-breakpoint
ALTER TABLE "core"."template_folders" ADD CONSTRAINT "template_folders_parent_id_template_folders_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "core"."template_folders"("id");