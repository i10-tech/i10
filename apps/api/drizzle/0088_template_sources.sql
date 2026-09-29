CREATE TYPE "core"."template_source" AS ENUM('managed', 'upload', 'github');--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD COLUMN "files" jsonb;--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "core"."template_versions" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "core"."templates" ADD COLUMN "source" "core"."template_source" DEFAULT 'managed' NOT NULL;