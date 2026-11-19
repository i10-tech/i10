CREATE TYPE "core"."webhook_endpoint_health" AS ENUM('healthy', 'failing', 'disabled');--> statement-breakpoint
CREATE TYPE "core"."webhook_health_change" AS ENUM('failing', 'disabled', 'recovered');--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'webhook_endpoint.failing';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'webhook_endpoint.disabled';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'webhook_endpoint.recovered';--> statement-breakpoint
CREATE TABLE "core"."webhook_health_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"kind" "core"."webhook_health_change" NOT NULL,
	"url" text NOT NULL,
	"reason" text,
	"failing_since" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fanned_out_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"email_suppressed" boolean DEFAULT false NOT NULL,
	"email_claimed_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "core"."webhook_health_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "health" "core"."webhook_endpoint_health" DEFAULT 'healthy' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "health_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."webhook_health_events" ADD CONSTRAINT "webhook_health_events_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "core"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_health_events_tenant_idx" ON "core"."webhook_health_events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "webhook_health_events_endpoint_idx" ON "core"."webhook_health_events" USING btree ("endpoint_id","occurred_at");--> statement-breakpoint
CREATE INDEX "webhook_health_events_unfanned_idx" ON "core"."webhook_health_events" USING btree ("occurred_at") WHERE "core"."webhook_health_events"."fanned_out_at" is null;--> statement-breakpoint
CREATE INDEX "webhook_health_events_unemailed_idx" ON "core"."webhook_health_events" USING btree ("tenant_id") WHERE "core"."webhook_health_events"."emailed_at" is null;--> statement-breakpoint
CREATE POLICY "webhook_health_events_tenant" ON "core"."webhook_health_events" AS PERMISSIVE FOR ALL TO public USING ("core"."webhook_health_events"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."webhook_health_events"."tenant_id" = current_setting('app.tenant_id')::uuid);