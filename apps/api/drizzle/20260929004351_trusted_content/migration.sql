CREATE TABLE "core"."risk_boilerplate" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"skeleton_hash" text NOT NULL,
	"segments" jsonb NOT NULL,
	"hole_limits" jsonb NOT NULL,
	"bands" text[] NOT NULL,
	"static_bytes" integer NOT NULL,
	"holes" integer NOT NULL,
	"model" text,
	"embedding" halfvec(384),
	"reason" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."risk_boilerplate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."risk_boilerplate_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"boilerplate_id" uuid NOT NULL,
	"name" text NOT NULL,
	"skeleton_hash" text NOT NULL,
	"action" text NOT NULL,
	"set_by" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."risk_boilerplate_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."trusted_template_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"action" text NOT NULL,
	"set_by" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."trusted_template_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."trusted_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"html" text,
	"text" text,
	"skeleton_hash" text NOT NULL,
	"segments" jsonb NOT NULL,
	"holes" jsonb NOT NULL,
	"bands" text[] NOT NULL,
	"static_hosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_by" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"matched" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."trusted_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."content_fingerprints" ADD COLUMN "trusted_by" text;--> statement-breakpoint
ALTER TABLE "core"."content_vectors" ADD COLUMN "trusted_by" text;--> statement-breakpoint
ALTER TABLE "core"."message_bodies" ADD COLUMN "trusted_template_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."trusted_template_events" ADD CONSTRAINT "trusted_template_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."trusted_templates" ADD CONSTRAINT "trusted_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_boilerplate_name_unique" ON "core"."risk_boilerplate" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_boilerplate_skeleton_unique" ON "core"."risk_boilerplate" USING btree ("skeleton_hash");--> statement-breakpoint
CREATE INDEX "risk_boilerplate_events_time_idx" ON "core"."risk_boilerplate_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "trusted_template_events_tenant_idx" ON "core"."trusted_template_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "trusted_templates_tenant_idx" ON "core"."trusted_templates" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_templates_live_unique" ON "core"."trusted_templates" USING btree ("tenant_id","skeleton_hash") WHERE status in ('pending', 'approved');--> statement-breakpoint
CREATE POLICY "risk_boilerplate_deny" ON "core"."risk_boilerplate" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "risk_boilerplate_events_deny" ON "core"."risk_boilerplate_events" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "trusted_template_events_tenant" ON "core"."trusted_template_events" AS PERMISSIVE FOR ALL TO public USING ("core"."trusted_template_events"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."trusted_template_events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "trusted_templates_tenant" ON "core"."trusted_templates" AS PERMISSIVE FOR ALL TO public USING ("core"."trusted_templates"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."trusted_templates"."tenant_id" = current_setting('app.tenant_id')::uuid);