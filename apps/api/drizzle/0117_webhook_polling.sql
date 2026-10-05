CREATE TYPE "core"."webhook_endpoint_kind" AS ENUM('http', 'polling');--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_health_events" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "kind" "core"."webhook_endpoint_kind" DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "poll_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_sequence_idx" ON "core"."webhook_deliveries" USING btree ("endpoint_id","sequence");