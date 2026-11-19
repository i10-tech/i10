ALTER TYPE "core"."webhook_attempt_error" ADD VALUE 'transform';--> statement-breakpoint
ALTER TABLE "core"."webhook_deliveries" ADD COLUMN "transformed" jsonb;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "transformation" text;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "transformation_enabled" boolean DEFAULT false NOT NULL;