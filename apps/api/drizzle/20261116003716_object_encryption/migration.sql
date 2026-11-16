ALTER TABLE "core"."content_objects" ADD COLUMN "sealed_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."mailbox_jobs" ADD COLUMN "sealed_key" text;