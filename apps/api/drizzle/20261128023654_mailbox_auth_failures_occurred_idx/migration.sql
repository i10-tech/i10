-- A plain CREATE INDEX takes SHARE on the table for the build. The table is
-- empty in production when this ships (#388), so the build is instant; the
-- lock timeout keeps a stuck lock from stalling the deploy.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "mailbox_auth_failures_occurred_idx" ON "core"."mailbox_auth_failures" ("occurred_at");