CREATE TYPE "core"."domain_status" AS ENUM('not_started', 'pending', 'verified', 'failed', 'temporary_failure');--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "dkim_tokens" text[];--> statement-breakpoint
ALTER TABLE "core"."domains" ADD COLUMN "status" "core"."domain_status" DEFAULT 'not_started' NOT NULL;--> statement-breakpoint

-- ⚠ EXISTING ROWS KEEP THE TRUTH THEY ALREADY CARRIED. The column defaults to
-- `not_started`, which is wrong for any domain that is already verified — and
-- wrong in the direction that stops a working domain from sending, because the
-- send path is about to gate on it.
UPDATE core.domains
   SET status = 'verified'
 WHERE verified_at IS NOT NULL;
