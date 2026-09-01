CREATE SCHEMA "core";
--> statement-breakpoint
CREATE TYPE "core"."message_event_type" AS ENUM('queued', 'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "core"."message_queue" AS ENUM('transactional', 'bulk');--> statement-breakpoint
CREATE TYPE "core"."message_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "core"."suppression_reason" AS ENUM('hard_bounce', 'complaint', 'manual', 'unsubscribe');--> statement-breakpoint
CREATE TYPE "core"."tenant_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TABLE "core"."api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_key_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_clerk_key_id_unique" UNIQUE("clerk_key_id")
);
--> statement-breakpoint
CREATE TABLE "core"."domains" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sends" boolean DEFAULT true NOT NULL,
	"hosts_mailboxes" boolean DEFAULT false NOT NULL,
	"mail_from_subdomain" text DEFAULT 'send' NOT NULL,
	"dkim_selector" text,
	"dkim_public_key" text,
	"dkim_private_key_ref" text,
	"ses_tenant_name" text,
	"verified_at" timestamp with time zone,
	"dns_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "core"."idempotency_keys" (
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "core"."message_bodies" (
	"message_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"text" text,
	"html" text,
	"headers" jsonb,
	CONSTRAINT "message_bodies_message_id_created_at_pk" PRIMARY KEY("message_id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "core"."message_events" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"type" "core"."message_event_type" NOT NULL,
	"source_event_id" text,
	"payload" jsonb,
	CONSTRAINT "message_events_id_occurred_at_pk" PRIMARY KEY("id","occurred_at")
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE TABLE "core"."messages" (
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"domain_id" uuid,
	"api_key_id" uuid,
	"queue" "core"."message_queue" DEFAULT 'transactional' NOT NULL,
	"status" "core"."message_status" DEFAULT 'queued' NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" text[] NOT NULL,
	"cc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"bcc_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"reply_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"ses_message_id" text,
	"last_error" text,
	CONSTRAINT "messages_id_created_at_pk" PRIMARY KEY("id","created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "core"."suppressions" (
	"tenant_id" uuid NOT NULL,
	"address" text NOT NULL,
	"reason" "core"."suppression_reason" NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_tenant_id_address_pk" PRIMARY KEY("tenant_id","address")
);
--> statement-breakpoint
CREATE TABLE "core"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"clerk_org_id" text,
	"owner_clerk_user_id" text NOT NULL,
	"status" "core"."tenant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_clerk_org_id_unique" UNIQUE("clerk_org_id")
);
--> statement-breakpoint
ALTER TABLE "authd"."accounts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."domains" ADD CONSTRAINT "domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."suppressions" ADD CONSTRAINT "suppressions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "core"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "core"."api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "domains_tenant_idx" ON "core"."domains" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "core"."idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "message_events_message_idx" ON "core"."message_events" USING btree ("message_id","occurred_at");--> statement-breakpoint
CREATE INDEX "message_events_tenant_idx" ON "core"."message_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_events_source_idx" ON "core"."message_events" USING btree ("source_event_id","occurred_at");--> statement-breakpoint
CREATE INDEX "messages_claim_idx" ON "core"."messages" USING btree ("queue","status","created_at");--> statement-breakpoint
CREATE INDEX "messages_tenant_recent_idx" ON "core"."messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_ses_id_idx" ON "core"."messages" USING btree ("ses_message_id");--> statement-breakpoint
CREATE INDEX "tenants_owner_idx" ON "core"."tenants" USING btree ("owner_clerk_user_id");--> statement-breakpoint

-- Monthly partitions, created a year ahead.
--
-- ⚠ THE BOUNDS ARE WRITTEN WITH AN EXPLICIT +00 OFFSET. A bare date literal is
-- cast to timestamptz using the SESSION's TimeZone, so the same migration run
-- from two different clients would produce partitions with different boundaries
-- — and the rows that land either side of the seam are the ones you would never
-- think to check.
--
-- The DEFAULT partition is a safety net for the day the maintenance job that
-- extends this window fails, not a design. Rows landing in it must be moved
-- before the matching month can be attached, so it should always be empty.
DO $$
DECLARE
  tbl text;
  m date;
  start_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['messages', 'message_bodies', 'message_events'] LOOP
    FOR i IN 0..11 LOOP
      m := (start_month + (i || ' months')::interval)::date;
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS core.%I PARTITION OF core.%I FOR VALUES FROM (%L) TO (%L)',
        tbl || '_' || to_char(m, 'YYYY_MM'),
        tbl,
        to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00',
        to_char((m + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00'
      );
    END LOOP;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS core.%I PARTITION OF core.%I DEFAULT',
      tbl || '_default', tbl
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- Row level security.
--
-- ⚠ THE POLICIES READ `current_setting('app.tenant_id')` WITHOUT THE missing_ok
-- FLAG, ON PURPOSE. Passing `true` would make an unset tenant context evaluate
-- to NULL, every policy fail closed, and every query return zero rows — which
-- is indistinguishable from an empty account and would be debugged as a data
-- problem. Strict, it raises on the first query instead, naming the fault.
--
-- Both forms are errors, and which one you see depends on the connection's
-- history: a connection that has never set the parameter raises
-- `unrecognized configuration parameter "app.tenant_id"`, while one that set it
-- inside an earlier transaction reverts to an EMPTY value on commit and raises
-- `invalid input syntax for type uuid: ""` instead. Under PgBouncer the second
-- is the one you will actually meet, and on its own it reads like a bad
-- parameter rather than a missing `withTenant()` — which is the only reason it
-- is written down here.
--
-- ⚠ ENABLE, NOT FORCE. FORCE would apply the policies to the table owner too,
-- and the owner is what runs migrations and backfills — work that is legitimately
-- cross-tenant. The guarantee comes from the application never connecting as
-- the owner, which `assertRlsSubject()` checks at boot rather than trusting.
ALTER TABLE "core"."tenants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "core"."tenants"
  USING ("id" = current_setting('app.tenant_id')::uuid)
  WITH CHECK ("id" = current_setting('app.tenant_id')::uuid);
--> statement-breakpoint

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'domains', 'api_keys', 'idempotency_keys',
    'messages', 'message_bodies', 'message_events', 'suppressions'
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

-- Least-privilege access for the application role.
--
-- ⚠ THE ROLE IS CREATED BY CNPG, NOT HERE — `managed.roles` in
-- infra/k8s/i10/platform-db/cluster.yaml owns its existence and password, the
-- same arrangement as `authd`. Running this before CNPG has reconciled it fails
-- on the first GRANT, which is the correct order rather than a problem.
GRANT CONNECT ON DATABASE i10 TO i10_api;
--> statement-breakpoint
GRANT USAGE ON SCHEMA core TO i10_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO i10_api;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO i10_api;
--> statement-breakpoint

-- The sweeper is the other query that is legitimately cross-tenant: finding
-- messages that no worker is going to pick up needs to look at every tenant's
-- rows before it knows whose they are. Same treatment as the key lookup — one
-- narrow question, answered by the owner, returning only what the worker needs
-- to re-enqueue.
--
-- Two populations, one purpose. `queued` rows older than the grace period are
-- the dual-write gap: the row committed and the Redis enqueue never happened.
-- `sending` rows past the claim timeout are the ambiguous ones — SES was called
-- and the outcome was never recorded. Both are returned for re-enqueue, and
-- what makes that safe for the second population is that the retry reuses the
-- same Message-ID.
CREATE FUNCTION "core"."sweep_stuck_messages"(
  queued_grace interval,
  claim_timeout interval,
  max_rows integer
)
RETURNS TABLE (id uuid, created_at timestamptz, tenant_id uuid, queue text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT m.id, m.created_at, m.tenant_id, m.queue::text
    FROM core.messages m
   WHERE (m.status = 'queued' AND m.created_at < now() - queued_grace)
      OR (m.status = 'sending' AND m.claimed_at < now() - claim_timeout)
   ORDER BY m.created_at
   LIMIT max_rows;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "core"."sweep_stuck_messages"(interval, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "core"."sweep_stuck_messages"(interval, interval, integer) TO i10_api;
