ALTER TABLE "core"."domains" ADD COLUMN "onboarding_email_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "onboarding_email_to" text;--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "onboarding_email_at" timestamp with time zone;