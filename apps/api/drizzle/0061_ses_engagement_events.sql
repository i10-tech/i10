ALTER TYPE "core"."message_event_type" ADD VALUE 'opened';--> statement-breakpoint
ALTER TYPE "core"."message_event_type" ADD VALUE 'clicked';--> statement-breakpoint
ALTER TYPE "core"."message_event_type" ADD VALUE 'unsubscribed';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'email.opened';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'email.clicked';--> statement-breakpoint
ALTER TYPE "core"."webhook_event_type" ADD VALUE 'email.unsubscribed';--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "open_tracking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "click_tracking" boolean DEFAULT false NOT NULL;