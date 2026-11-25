-- ⚠ A LOCK TIMEOUT FIRST. Creating an index takes a SHARE lock on
-- `authd.mail_devices` (blocks writes while building). The table is empty on
-- initial PR 2 deploy; five seconds and the batch fails (the Job retries)
-- instead of stalling writes behind an open transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX "mail_devices_tenant_created_idx" ON "authd"."mail_devices" ("tenant_id","created_at" DESC,"id" DESC);
