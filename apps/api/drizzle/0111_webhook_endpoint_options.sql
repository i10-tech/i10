ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "filter_domains" text[];--> statement-breakpoint
ALTER TABLE "core"."webhook_endpoints" ADD COLUMN "filter_tags" jsonb;