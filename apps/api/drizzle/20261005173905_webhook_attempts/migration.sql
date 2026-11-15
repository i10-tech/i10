CREATE TYPE "core"."webhook_attempt_error" AS ENUM('status', 'timeout', 'connect', 'tls', 'blocked', 'unresolved');--> statement-breakpoint
CREATE TYPE "core"."webhook_attempt_trigger" AS ENUM('scheduled', 'manual', 'recover', 'replay', 'test');--> statement-breakpoint
CREATE TABLE "core"."webhook_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"trigger" "core"."webhook_attempt_trigger" DEFAULT 'scheduled' NOT NULL,
	"lane" "core"."webhook_delivery_lane" NOT NULL,
	"url" text NOT NULL,
	"request_headers" jsonb NOT NULL,
	"response_status" integer,
	"response_headers" jsonb,
	"response_body" text,
	"duration_ms" integer NOT NULL,
	"error_kind" "core"."webhook_attempt_error",
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "core"."webhook_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD COLUMN "payload_expunged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."webhook_attempts" ADD CONSTRAINT "webhook_attempts_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "core"."webhook_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_attempts_delivery_idx" ON "core"."webhook_attempts" USING btree ("delivery_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_attempts_endpoint_idx" ON "core"."webhook_attempts" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE POLICY "webhook_attempts_tenant" ON "core"."webhook_attempts" AS PERMISSIVE FOR ALL TO public USING ("core"."webhook_attempts"."tenant_id" = current_setting('app.tenant_id')::uuid) WITH CHECK ("core"."webhook_attempts"."tenant_id" = current_setting('app.tenant_id')::uuid);