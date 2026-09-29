ALTER TYPE "core"."template_kind" ADD VALUE 'visual';--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD COLUMN "design" jsonb;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "design" jsonb;