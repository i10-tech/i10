-- ⚠ A LOCK TIMEOUT FIRST. Dropping the two enrollment/permit tables and adding
-- `enrollment_id` + `acme_bound_at` (both nullable, no table rewrite in PG 11+)
-- and the partial unique index take ACCESS EXCLUSIVE / SHARE briefly on empty
-- or tiny tables. Five seconds, then fail and retry instead of queueing traffic.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "authd"."mail_device_cert_permits" DROP CONSTRAINT "mail_device_cert_permits_enrollment_fk";--> statement-breakpoint
DROP TABLE "authd"."mail_device_cert_permits";--> statement-breakpoint
DROP TABLE "authd"."mail_device_enrollments";--> statement-breakpoint
ALTER TABLE "authd"."mail_devices" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "authd"."mail_devices" ADD COLUMN "acme_bound_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_devices_enrollment_id_unique" ON "authd"."mail_devices" ("enrollment_id") WHERE "enrollment_id" is not null;
