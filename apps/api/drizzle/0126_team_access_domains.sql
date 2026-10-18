CREATE TABLE "core"."join_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."join_dismissals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."join_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."join_exclusions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."join_memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"how" text NOT NULL,
	"via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."join_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."join_domains" DROP CONSTRAINT "join_domains_domain_id_domains_id_fk";
--> statement-breakpoint
ALTER TABLE "core"."join_domains" ALTER COLUMN "domain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD COLUMN "source" text DEFAULT 'domains' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD COLUMN "token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD COLUMN "lapsed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD COLUMN "displaced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."join_requests" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "core"."join_requests" ADD COLUMN "full" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."join_dismissals" ADD CONSTRAINT "join_dismissals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."join_exclusions" ADD CONSTRAINT "join_exclusions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."join_memberships" ADD CONSTRAINT "join_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_dismissals_tenant_name_unique" ON "core"."join_dismissals" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "join_exclusions_tenant_email_unique" ON "core"."join_exclusions" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "join_memberships_tenant_user_unique" ON "core"."join_memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "join_memberships_user_idx" ON "core"."join_memberships" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD CONSTRAINT "join_domains_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "core"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "join_domains_recheck_read" ON "core"."join_domains" AS PERMISSIVE FOR SELECT TO public USING (current_setting('app.join_recheck', true) = 'on');--> statement-breakpoint
CREATE POLICY "join_dismissals_workspace" ON "core"."join_dismissals" AS PERMISSIVE FOR ALL TO public USING ("core"."join_dismissals"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."join_dismissals"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "join_exclusions_workspace" ON "core"."join_exclusions" AS PERMISSIVE FOR ALL TO public USING ("core"."join_exclusions"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."join_exclusions"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "join_memberships_workspace" ON "core"."join_memberships" AS PERMISSIVE FOR ALL TO public USING ("core"."join_memberships"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."join_memberships"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "join_memberships_member_read" ON "core"."join_memberships" AS PERMISSIVE FOR SELECT TO public USING ("core"."join_memberships"."user_id" = nullif(current_setting('app.user_id', true), ''));