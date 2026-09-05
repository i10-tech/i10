CREATE TYPE "core"."delivery_route" AS ENUM('auto', 'ses', 'direct');--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "bounce_subdomain" text DEFAULT 'bounce' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "delivery_route" "core"."delivery_route" DEFAULT 'auto' NOT NULL;