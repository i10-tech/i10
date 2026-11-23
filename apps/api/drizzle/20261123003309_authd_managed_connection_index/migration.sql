-- ⚠ A LOCK TIMEOUT FIRST. CREATE INDEX holds a SHARE lock on
-- `authd.managed_accounts` for the build and waits behind any open writer; five
-- seconds and it fails (the Job retries) instead of queueing every later write.
-- The table holds one row per managed account, so the build itself is instant.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "authd_managed_connection_idx" ON "authd"."managed_accounts" ("connection_id");