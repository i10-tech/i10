CREATE TYPE "core"."hold_scope" AS ENUM('api', 'all');--> statement-breakpoint
CREATE TYPE "core"."risk_band" AS ENUM('low', 'elevated', 'high', 'critical');--> statement-breakpoint
CREATE TABLE "core"."content_fingerprints" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"exact" text NOT NULL,
	"bands" text[] NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_fingerprints_tenant_id_day_exact_pk" PRIMARY KEY("tenant_id","day","exact")
);
--> statement-breakpoint
ALTER TABLE "core"."content_fingerprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."identity_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"tenant_id" uuid,
	"kind" text NOT NULL,
	"session_id" text,
	"ip" text,
	"subnet" text,
	"country" text,
	"asn" integer,
	"as_name" text,
	"hosting" boolean,
	"tor" boolean,
	"user_agent" text,
	"device_id" text,
	"timezone" text,
	"language" text,
	"detail" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."identity_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."link_hosts" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"host" text NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"verdict" text,
	"checked_at" timestamp with time zone,
	CONSTRAINT "link_hosts_tenant_id_day_host_pk" PRIMARY KEY("tenant_id","day","host")
);
--> statement-breakpoint
ALTER TABLE "core"."link_hosts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."risk_assessment_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"band" "core"."risk_band" NOT NULL,
	"from_band" "core"."risk_band",
	"ruleset_version" integer NOT NULL,
	"contributions" jsonb NOT NULL,
	"actions" text[] DEFAULT '{}'::text[] NOT NULL,
	"trigger" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."risk_assessment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."risk_assessments" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"score" integer NOT NULL,
	"band" "core"."risk_band" NOT NULL,
	"ruleset_version" integer NOT NULL,
	"contributions" jsonb NOT NULL,
	"model_score" real,
	"band_since" timestamp with time zone DEFAULT now() NOT NULL,
	"auto_actions_paused_until" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"ses_policy" text,
	"ses_policy_set_at" timestamp with time zone,
	"alerted_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."risk_assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."risk_labels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"features" jsonb NOT NULL,
	"set_by" text NOT NULL,
	"note" text,
	"labeled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."risk_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."risk_models" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"evaluation" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."risk_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."sending_hold_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"action" text NOT NULL,
	"scope" "core"."hold_scope" NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"category" text,
	"set_by" text NOT NULL,
	"outcome" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."sending_hold_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "core"."sending_holds" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"scope" "core"."hold_scope" DEFAULT 'api' NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"category" text NOT NULL,
	"set_by" text NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_due_at" timestamp with time zone NOT NULL,
	"review_alerted_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"canceled_messages" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."sending_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."api_requests" ADD COLUMN "client_ip" text;--> statement-breakpoint
ALTER TABLE "core"."api_requests" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "rdap_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."content_fingerprints" ADD CONSTRAINT "content_fingerprints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."link_hosts" ADD CONSTRAINT "link_hosts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."risk_assessment_events" ADD CONSTRAINT "risk_assessment_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."risk_assessments" ADD CONSTRAINT "risk_assessments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."risk_labels" ADD CONSTRAINT "risk_labels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."sending_hold_events" ADD CONSTRAINT "sending_hold_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."sending_holds" ADD CONSTRAINT "sending_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_fingerprints_exact_idx" ON "core"."content_fingerprints" USING btree ("exact","day");--> statement-breakpoint
CREATE INDEX "content_fingerprints_bands_idx" ON "core"."content_fingerprints" USING gin ("bands");--> statement-breakpoint
CREATE INDEX "content_fingerprints_day_idx" ON "core"."content_fingerprints" USING btree ("day");--> statement-breakpoint
CREATE INDEX "identity_events_user_idx" ON "core"."identity_events" USING btree ("clerk_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "identity_events_device_idx" ON "core"."identity_events" USING btree ("device_id","occurred_at");--> statement-breakpoint
CREATE INDEX "identity_events_subnet_idx" ON "core"."identity_events" USING btree ("subnet","occurred_at");--> statement-breakpoint
CREATE INDEX "identity_events_unenriched_idx" ON "core"."identity_events" USING btree ("asn","occurred_at");--> statement-breakpoint
CREATE INDEX "link_hosts_unchecked_idx" ON "core"."link_hosts" USING btree ("day","checked_at");--> statement-breakpoint
CREATE INDEX "risk_assessment_events_tenant_idx" ON "core"."risk_assessment_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "risk_labels_tenant_idx" ON "core"."risk_labels" USING btree ("tenant_id","labeled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_models_version_unique" ON "core"."risk_models" USING btree ("version");--> statement-breakpoint
CREATE INDEX "sending_hold_events_tenant_idx" ON "core"."sending_hold_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE POLICY "content_fingerprints_tenant" ON "core"."content_fingerprints" AS PERMISSIVE FOR ALL TO public USING ("core"."content_fingerprints"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."content_fingerprints"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "identity_events_deny" ON "core"."identity_events" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "link_hosts_tenant" ON "core"."link_hosts" AS PERMISSIVE FOR ALL TO public USING ("core"."link_hosts"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."link_hosts"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "risk_assessment_events_tenant" ON "core"."risk_assessment_events" AS PERMISSIVE FOR ALL TO public USING ("core"."risk_assessment_events"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."risk_assessment_events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "risk_assessments_tenant" ON "core"."risk_assessments" AS PERMISSIVE FOR ALL TO public USING ("core"."risk_assessments"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."risk_assessments"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "risk_labels_tenant" ON "core"."risk_labels" AS PERMISSIVE FOR ALL TO public USING ("core"."risk_labels"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."risk_labels"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "risk_models_deny" ON "core"."risk_models" AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "sending_hold_events_tenant" ON "core"."sending_hold_events" AS PERMISSIVE FOR ALL TO public USING ("core"."sending_hold_events"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."sending_hold_events"."tenant_id" = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY "sending_holds_tenant" ON "core"."sending_holds" AS PERMISSIVE FOR ALL TO public USING ("core"."sending_holds"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."sending_holds"."tenant_id" = current_setting('app.tenant_id')::uuid);