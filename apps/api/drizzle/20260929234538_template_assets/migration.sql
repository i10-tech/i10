CREATE TABLE "core"."template_assets" (
	"tenant_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_assets_tenant_id_sha256_pk" PRIMARY KEY("tenant_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "core"."template_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "template_assets_tenant" ON "core"."template_assets" AS PERMISSIVE FOR ALL TO public USING ("core"."template_assets"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."template_assets"."tenant_id" = current_setting('app.tenant_id')::uuid);