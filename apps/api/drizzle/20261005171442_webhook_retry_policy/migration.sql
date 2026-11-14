CREATE TYPE "core"."webhook_retry_policy" AS ENUM('free', 'pro', 'scale', 'enterprise');--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD COLUMN "retry_policy" "core"."webhook_retry_policy" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "disabled_reason" text;