CREATE TYPE "core"."webhook_delivery_lane" AS ENUM('ordered', 'retry');--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD COLUMN "sequence" bigint;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD COLUMN "first_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD COLUMN "lane" "core"."webhook_delivery_lane" DEFAULT 'ordered' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "next_sequence" bigint DEFAULT 0 NOT NULL;