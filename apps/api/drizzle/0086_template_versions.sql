CREATE TYPE "core"."template_kind" AS ENUM('html', 'tsx');--> statement-breakpoint
CREATE TABLE "core"."template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" "core"."template_kind" NOT NULL,
	"subject" text,
	"html" text,
	"text" text,
	"nonce" text NOT NULL,
	"variables" jsonb NOT NULL,
	"source" text,
	"source_sha256" text,
	"runtime" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."template_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "template_version_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "kind" "core"."template_kind" DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "live_version_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD CONSTRAINT "template_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "core"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_number_uq" ON "core"."template_versions" USING btree ("template_id","number");--> statement-breakpoint
CREATE INDEX "template_versions_tenant_idx" ON "core"."template_versions" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "core"."templates" ADD CONSTRAINT "templates_live_version_id_template_versions_id_fk" FOREIGN KEY ("live_version_id") REFERENCES "core"."template_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "template_versions_tenant" ON "core"."template_versions" AS PERMISSIVE FOR ALL TO public USING ("core"."template_versions"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."template_versions"."tenant_id" = current_setting('app.tenant_id')::uuid);