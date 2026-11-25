-- ⚠ A LOCK TIMEOUT FIRST. The foreign key takes a SHARE ROW EXCLUSIVE lock on
-- `authd.accounts`, and the new column a brief ACCESS EXCLUSIVE lock on
-- `authd.passthrough_versions`; each waits behind any open writer and blocks
-- every later one while it waits, and `authd.accounts` is read and written on
-- every sign-in. Five seconds and the batch fails (the Job retries) instead of
-- stalling sign-ins (PostgreSQL docs, 13.3.1 "Table-Level Locks"). Nothing here
-- scans or rewrites a table: the new table is empty, the column is nullable with
-- no default, and the foreign key validates against no rows.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "authd"."mail_devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"clerk_user_id" text NOT NULL,
	"email" text NOT NULL,
	"tenant_id" uuid,
	"platform" text NOT NULL,
	"device_name" text,
	"model" text,
	"serial" text,
	"cert_sha256" bytea,
	"code_hash" bytea NOT NULL,
	"code_kid" smallint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_used_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "mail_devices_email_lowercase" CHECK ("email" = lower("email")),
	CONSTRAINT "mail_devices_platform_check" CHECK ("platform" in ('ios', 'ipados', 'macos')),
	CONSTRAINT "mail_devices_code_kid_check" CHECK ("code_kid" between 0 and 255),
	CONSTRAINT "mail_devices_used_together" CHECK (("first_used_at" is null) = ("last_used_at" is null))
);
--> statement-breakpoint
ALTER TABLE "authd"."passthrough_versions" ADD COLUMN "active" boolean;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_devices_cert_sha256_unique" ON "authd"."mail_devices" ("cert_sha256") WHERE "cert_sha256" is not null;--> statement-breakpoint
CREATE INDEX "mail_devices_account_idx" ON "authd"."mail_devices" ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "mail_devices_unused_idx" ON "authd"."mail_devices" ("created_at") WHERE "first_used_at" is null;--> statement-breakpoint
CREATE INDEX "mail_devices_last_used_idx" ON "authd"."mail_devices" ("last_used_at") WHERE "last_used_at" is not null;--> statement-breakpoint
ALTER TABLE "authd"."mail_devices" ADD CONSTRAINT "mail_devices_account_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "authd"."accounts"("clerk_user_id") ON DELETE CASCADE;