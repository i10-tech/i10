ALTER TABLE "core"."routing_settings" ADD COLUMN "mail_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."routing_settings" DROP COLUMN "free_plan_id";