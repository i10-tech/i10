CREATE TABLE "core"."join_domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"name" text NOT NULL,
	"clerk_org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."join_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."join_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"accepted" boolean
);
--> statement-breakpoint
ALTER TABLE "core"."join_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD CONSTRAINT "join_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."join_domains" ADD CONSTRAINT "join_domains_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "core"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."join_requests" ADD CONSTRAINT "join_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "join_domains_tenant_name_unique" ON "core"."join_domains" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "join_domains_name_idx" ON "core"."join_domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "join_requests_tenant_idx" ON "core"."join_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "join_requests_user_idx" ON "core"."join_requests" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_open_unique" ON "core"."join_requests" USING btree ("tenant_id","user_id") WHERE "core"."join_requests"."answered_at" is null;--> statement-breakpoint
CREATE POLICY "join_domains_workspace" ON "core"."join_domains" AS PERMISSIVE FOR ALL TO public USING ("core"."join_domains"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."join_domains"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "join_domains_seeker_read" ON "core"."join_domains" AS PERMISSIVE FOR SELECT TO public USING ("core"."join_domains"."name" = any(string_to_array(nullif(current_setting('app.seeker_domains', true), ''), ',')));--> statement-breakpoint
CREATE POLICY "join_requests_workspace" ON "core"."join_requests" AS PERMISSIVE FOR ALL TO public USING ("core"."join_requests"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."join_requests"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "join_requests_seeker_read" ON "core"."join_requests" AS PERMISSIVE FOR SELECT TO public USING ("core"."join_requests"."user_id" = nullif(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "join_requests_seeker_ask" ON "core"."join_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("core"."join_requests"."user_id" = nullif(current_setting('app.user_id', true), '') and exists (select 1 from core.join_domains d where d.tenant_id = "core"."join_requests"."tenant_id" and d.name = any(string_to_array(nullif(current_setting('app.seeker_domains', true), ''), ','))));