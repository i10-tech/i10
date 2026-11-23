-- ⚠ A LOCK TIMEOUT FIRST. CREATE INDEX holds a SHARE lock on the table for the
-- whole build, and waits behind any open writer first; every later write to
-- `core.domains` would queue behind that wait. Five seconds and it fails (the
-- Job retries) instead of taking domains down. It covers the rest of the
-- migration batch's transaction (PostgreSQL docs, 13.3.1 "Table-Level Locks").
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "domains_lower_name_idx" ON "core"."domains" (lower("name"));--> statement-breakpoint
CREATE INDEX "join_domains_lower_name_idx" ON "core"."join_domains" (lower("name"));