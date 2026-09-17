-- The console's own tables: marketing mail, templates, onboarding state, DNS
-- connections and the API request log.
--
-- ⚠ THE RLS BLOCK AT THE BOTTOM IS NOT OPTIONAL AND ITS ABSENCE FAILS SILENTLY.
-- `0002_tenancy` enabled row level security on the tables that existed then and
-- left an ALTER DEFAULT PRIVILEGES behind, so a table added later arrives with
-- its GRANTS already correct and NO POLICY AT ALL — readable and writable by
-- every tenant, with nothing in any log to say so. The only symptom is one
-- customer seeing another's contacts. Every migration that adds a table to
-- `core` adds its policy in the same migration; this one adds eleven.
--
-- ⚠ AND `messages.broadcast_id` NEEDS NO POLICY BECAUSE `core.messages` ALREADY
-- HAS ONE. A column inherits its table's protection.

CREATE TYPE "core"."broadcast_status" AS ENUM('draft', 'scheduled', 'sending', 'sent', 'canceled');--> statement-breakpoint
CREATE TYPE "core"."property_type" AS ENUM('string', 'number', 'boolean');--> statement-breakpoint
CREATE TYPE "core"."topic_default" AS ENUM('opt_in', 'opt_out');--> statement-breakpoint
CREATE TYPE "core"."topic_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "core"."api_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_name" text,
	"user_agent" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"segment_id" uuid,
	"topic_id" uuid,
	"name" text NOT NULL,
	"from_address" text NOT NULL,
	"reply_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"preview_text" text,
	"html" text,
	"text" text,
	"status" "core"."broadcast_status" DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"recipient_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."contact_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"type" "core"."property_type" DEFAULT 'string' NOT NULL,
	"fallback_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."contact_topics" (
	"contact_id" uuid NOT NULL,
	"topic_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subscribed" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_topics_contact_id_topic_id_pk" PRIMARY KEY("contact_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "core"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"unsubscribed" boolean DEFAULT false NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"properties" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."dns_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"label" text,
	"credential_sealed" text NOT NULL,
	"zones" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."onboarding" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"step" text DEFAULT 'workspace' NOT NULL,
	"completed_at" timestamp with time zone,
	"last_onboarded_plan" text,
	"use_case" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."segment_contacts" (
	"segment_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segment_contacts_segment_id_contact_id_pk" PRIMARY KEY("segment_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "core"."segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"folder" text,
	"subject" text,
	"html" text,
	"text" text,
	"published_html" text,
	"published_text" text,
	"published_subject" text,
	"published_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_subscription" "core"."topic_default" DEFAULT 'opt_in' NOT NULL,
	"visibility" "core"."topic_visibility" DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."messages" ADD COLUMN "broadcast_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."api_requests" ADD CONSTRAINT "api_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."broadcasts" ADD CONSTRAINT "broadcasts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."broadcasts" ADD CONSTRAINT "broadcasts_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "core"."segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."broadcasts" ADD CONSTRAINT "broadcasts_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "core"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contact_properties" ADD CONSTRAINT "contact_properties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contact_topics" ADD CONSTRAINT "contact_topics_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "core"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contact_topics" ADD CONSTRAINT "contact_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "core"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contact_topics" ADD CONSTRAINT "contact_topics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."dns_connections" ADD CONSTRAINT "dns_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."onboarding" ADD CONSTRAINT "onboarding_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."segment_contacts" ADD CONSTRAINT "segment_contacts_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "core"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."segment_contacts" ADD CONSTRAINT "segment_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "core"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."segment_contacts" ADD CONSTRAINT "segment_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."segments" ADD CONSTRAINT "segments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD CONSTRAINT "templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."topics" ADD CONSTRAINT "topics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_requests_tenant_idx" ON "core"."api_requests" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "broadcasts_tenant_idx" ON "core"."broadcasts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_properties_tenant_key_uq" ON "core"."contact_properties" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "contact_topics_topic_idx" ON "core"."contact_topics" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "contact_topics_tenant_idx" ON "core"."contact_topics" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_tenant_email_uq" ON "core"."contacts" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "contacts_tenant_idx" ON "core"."contacts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "dns_connections_tenant_idx" ON "core"."dns_connections" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "segment_contacts_contact_idx" ON "core"."segment_contacts" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "segment_contacts_tenant_idx" ON "core"."segment_contacts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "segments_tenant_idx" ON "core"."segments" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "templates_tenant_idx" ON "core"."templates" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_tenant_name_uq" ON "core"."templates" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "topics_tenant_idx" ON "core"."topics" USING btree ("tenant_id","created_at");
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- Row level security for the eleven new tables.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every one of them carries `tenant_id`, so the policy is the same plain
-- equality the rest of `core` uses — including the two JOIN TABLES, which carry
-- a denormalised `tenant_id` for exactly this reason. A policy that reached the
-- tenant through `segment_id` would be a join evaluated per row against a table
-- that is itself under RLS, on the tables that grow fastest here.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'contacts', 'contact_properties', 'segments', 'segment_contacts',
    'topics', 'contact_topics', 'broadcasts', 'templates',
    'onboarding', 'dns_connections', 'api_requests'
  ] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON core.%I '
      'USING (tenant_id = current_setting(''app.tenant_id'')::uuid) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      tbl
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- ⚠ PARTIAL, BECAUSE ALMOST EVERY MESSAGE HAS NO BROADCAST. A full index on a
-- mostly-NULL column on the largest table in the database costs write
-- throughput on the send path — the hottest path there is — to speed up a query
-- only a broadcast page ever issues. `WHERE broadcast_id IS NOT NULL` is read by
-- the planner for exactly that query and by nothing else.
--
-- ⚠ AND IT IS CREATED ON THE PARTITIONED PARENT, so every existing partition
-- gets it and every future one inherits it. Creating it per partition would
-- work today and be forgotten by whatever creates next month's.
CREATE INDEX "messages_broadcast_idx"
  ON "core"."messages" USING btree ("broadcast_id", "created_at")
  WHERE "broadcast_id" IS NOT NULL;
