-- ⚠ A LOCK TIMEOUT FIRST. Adding `enrollment_id`, dropping and recreating the
-- open-ACME partial unique index, adding the enrollment index and adding the
-- NOT VALID constraints on `authd.mail_device_cert_permits` take ACCESS
-- EXCLUSIVE (and SHARE for index builds) on `authd.mail_device_cert_permits`.
-- The foreign keys on `authd.mail_device_enrollments` take SHARE ROW EXCLUSIVE
-- on `authd.accounts` and `authd.mail_devices` (blocking API writes, not
-- authd or mailfront reads). Five seconds and the batch fails (Job retries)
-- instead of queuing traffic behind DDL (PostgreSQL docs 13.3.1).
--
-- Nothing here scans a growing table: `authd.mail_device_enrollments` is brand
-- new and empty, and `authd.mail_device_cert_permits` holds at most a few
-- operator-made ACME probe rows in production (no SCEP permits exist before
-- PR 4 ships). Both new constraints on `authd.mail_device_cert_permits` are
-- added NOT VALID here and validated in the next migration.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "authd"."mail_device_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7(),
	"clerk_user_id" text NOT NULL,
	"email" text NOT NULL,
	"tenant_id" uuid,
	"expected_epoch" bigint NOT NULL,
	"token_sha256" bytea NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"refusal" text,
	"serial" text,
	"product" text,
	"os_version" text,
	"device_name" text,
	"udid_sha256" bytea,
	"apple_signer_sha256" bytea,
	"platform" text,
	"device_id" uuid,
	"sealed_profile" bytea,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_device_enrollments_email_lowercase" CHECK ("email" = lower("email")),
	CONSTRAINT "mail_device_enrollments_status_check" CHECK ("status" in ('open', 'attested', 'sealed', 'refused', 'expired', 'cancelled')),
	CONSTRAINT "mail_device_enrollments_refusal_state" CHECK (("status" = 'refused') = ("refusal" is not null)
          and ("refusal" is null or "refusal" <> '')),
	CONSTRAINT "mail_device_enrollments_platform_check" CHECK ("platform" is null or "platform" in ('ios', 'ipados', 'macos')),
	CONSTRAINT "mail_device_enrollments_serial_check" CHECK ("serial" is null or "serial" <> ''),
	CONSTRAINT "mail_device_enrollments_hash_lengths" CHECK (octet_length("token_sha256") = 32
          and ("udid_sha256" is null or octet_length("udid_sha256") = 32)
          and ("apple_signer_sha256" is null or octet_length("apple_signer_sha256") = 32)),
	CONSTRAINT "mail_device_enrollments_attested_state" CHECK ("status" not in ('attested', 'sealed')
          or ("serial" is not null
              and "product" is not null
              and "os_version" is not null
              and "udid_sha256" is not null
              and "apple_signer_sha256" is not null
              and "platform" is not null)),
	CONSTRAINT "mail_device_enrollments_sealed_profile_state" CHECK (("status" = 'sealed') = ("sealed_profile" is not null)
          and ("sealed_profile" is null or octet_length("sealed_profile") > 0)),
	CONSTRAINT "mail_device_enrollments_expiry_check" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_permits" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
DROP INDEX "authd"."mail_device_cert_permits_open_acme_serial";--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_cert_permits_open_acme_serial" ON "authd"."mail_device_cert_permits" ("serial","clerk_user_id") WHERE "kind" = 'acme' and "status" = 'open';--> statement-breakpoint
CREATE INDEX "mail_device_cert_permits_enrollment_idx" ON "authd"."mail_device_cert_permits" ("enrollment_id") WHERE "enrollment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_enrollments_token_unique" ON "authd"."mail_device_enrollments" ("token_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_device_enrollments_live_account_unique" ON "authd"."mail_device_enrollments" ("clerk_user_id") WHERE "status" in ('open', 'attested');--> statement-breakpoint
CREATE INDEX "mail_device_enrollments_account_idx" ON "authd"."mail_device_enrollments" ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "mail_device_enrollments_device_idx" ON "authd"."mail_device_enrollments" ("device_id") WHERE "device_id" is not null;--> statement-breakpoint
CREATE INDEX "mail_device_enrollments_expires_idx" ON "authd"."mail_device_enrollments" ("expires_at");--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_permits" ADD CONSTRAINT "mail_device_cert_permits_enrollment_fk" FOREIGN KEY ("enrollment_id") REFERENCES "authd"."mail_device_enrollments"("id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "authd"."mail_device_enrollments" ADD CONSTRAINT "mail_device_enrollments_account_fk" FOREIGN KEY ("clerk_user_id") REFERENCES "authd"."accounts"("clerk_user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "authd"."mail_device_enrollments" ADD CONSTRAINT "mail_device_enrollments_device_fk" FOREIGN KEY ("device_id") REFERENCES "authd"."mail_devices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_permits" ADD CONSTRAINT "mail_device_cert_permits_enrollment_kind" CHECK (("kind" = 'scep') = ("enrollment_id" is not null)) NOT VALID;